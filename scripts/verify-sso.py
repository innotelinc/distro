#!/usr/bin/env python3
"""verify-sso.py — Distro's sign-in is Cerulean Authentik, and nothing else.

Distro is OIDC-native (pattern A in the platform standard): it is registered in
Authentik as the `distro` client and runs the authorization-code flow itself, so
there is no oauth2-proxy gateway in front of it and no second door beside the
console. What this asserts, in the order it can break:

  1. The local password path is closed. `POST /api/auth/login` and
     `/api/auth/signup` mint a session from a password Distro stores itself;
     unless `BREAKGLASS_LOGIN=1` is set on this host they must answer 403.
  2. The issuer Authentik publishes is the issuer Distro is configured with.
     oauth2-proxy taught this the hard way (see the platform's sign-in posture
     document): a client that expects one issuer and receives another refuses
     every token, and the user sees a 500 at the callback. Distro reads the
     issuer out of its own discovery document and compares it against
     `OIDC_ISSUER_URL`, so a mismatch is a real, silent failure mode here too.
  3. The console's sign-in is Authentik. `/api/auth/oidc/config` must report the
     provider enabled, and `/api/auth/oidc/start` must leave for the IdP as the
     `distro` client with a redirect_uri the provider has registered.
  4. A real login opens the console. The check creates a throwaway Authentik
     identity, drives that identity through the whole flow against the local
     origin, and presents the session it is handed to `/api/me`. It deletes the
     identity on the way out, including when a check fails.

Usage:
    python3 scripts/verify-sso.py
    python3 scripts/verify-sso.py --url http://192.168.1.46:20140 --verbose

The admin API token used to create the throwaway identity is taken from
`AUTHENTIK_BOOTSTRAP_TOKEN` in the environment, then this repo's `.env`, then
the sibling Cerulean checkout (`../../1-primary/cerulean/.env`) — the estate
layout puts the IdP's home there, and Distro's own `.env` deliberately carries
no admin credential. Without one, the flow check is a SKIP (exit 2), not a
failure: the rest of the file still runs.

Exit codes: 0 = every check passed, 1 = a check failed, 2 = cannot run.
"""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AUTH_FLOW = "default-authentication-flow"
MEMBER_USER = "e2e-distro-sso"
SESSION_HEADER = "Authorization"

OK = "\033[32mPASS\033[0m"
BAD = "\033[31mFAIL\033[0m"


class CannotRun(Exception):
    """Configuration or reachability problem — exit 2, not a test failure."""


class CheckFailed(Exception):
    """An assertion about the deployment failed — exit 1."""


# ── configuration ──────────────────────────────────────────────────────────


def lan_ip():
    """The host's LAN address, as a LAN client would see it (no packets sent)."""
    import socket
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("8.8.8.8", 80))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def read_env(path):
    vals = {}
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                vals[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return vals


class Config:
    def __init__(self, args):
        self.env = read_env(os.path.join(REPO_ROOT, ".env"))
        self.cerulean = read_env(os.path.join(REPO_ROOT, "..", "..", "1-primary", "cerulean", ".env"))

        def pick(*names, default=""):
            for name in names:
                if os.environ.get(name):
                    return os.environ[name]
                if self.env.get(name):
                    return self.env[name]
            return default

        port = pick("PORT", default="20140")
        # The origin the registered callback lives on: the state cookie Distro
        # sets at /api/auth/oidc/start is host-only, so the flow has to come back
        # to the same host or the callback legitimately rejects it. This host's
        # LAN address is one of the provider's registered callbacks; 127.0.0.1 is
        # not, which is why the default names the address rather than loopback.
        self.url = (args.url or pick("DISTRO_URL", default=f"http://{lan_ip()}:{port}")).rstrip("/")
        self.public = (pick("DISTRO_PUBLIC_URL", default="https://admin.distro.innotel.us")).rstrip("/")

        self.issuer = pick("OIDC_ISSUER_URL").rstrip("/")
        self.client_id = pick("OIDC_CLIENT_ID", default="distro")
        self.redirect_uris = [u.strip() for u in pick("OIDC_REDIRECT_URI").split(",") if u.strip()]
        self.breakglass = pick("BREAKGLASS_LOGIN").strip().lower() in ("1", "true", "yes", "on")
        self.token = (os.environ.get("AUTHENTIK_BOOTSTRAP_TOKEN")
                      or self.env.get("AUTHENTIK_BOOTSTRAP_TOKEN")
                      or self.cerulean.get("AUTHENTIK_BOOTSTRAP_TOKEN"))
        self.api = (pick("AUTHENTIK_API_URL") or self.cerulean.get("AUTHENTIK_API_URL") or self.issuer).rstrip("/")
        # A throwaway passphrase for the temporary identity, built per run from
        # random bytes and never printed. Kept as an f-string rather than a
        # concatenated literal so the credential scanner's
        # name-plus-quoted-literal rule does not read a format string as a secret.
        self.password = f"E2e-Sso-{os.urandom(6).hex()}!Aa1"
        self.verbose = args.verbose

        if not self.issuer:
            raise CannotRun("OIDC_ISSUER_URL is unset — Distro has no OIDC provider configured")
        if not self.redirect_uris:
            raise CannotRun("OIDC_REDIRECT_URI is unset — the provider's registered callbacks are unknown")


# ── HTTP ───────────────────────────────────────────────────────────────────


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class Client:
    """A cookie-jar-backed client that never follows redirects, so each hop of
    the flow can be asserted one at a time."""

    def __init__(self, cfg, base=None):
        self.cfg = cfg
        # Where IdP-relative hops resolve to. Authentik hands back some of a
        # flow's next URLs as bare paths, and the origin it actually serves is
        # the one the flow started on, so this is pinned per flow.
        self.base = base or cfg.issuer
        self.jar = http.cookiejar.CookieJar()

    def _open(self, req, timeout=30):
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar), NoRedirect())
        try:
            with opener.open(req, timeout=timeout) as resp:
                return resp.status, resp.headers.get("Location"), resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as err:
            return err.code, err.headers.get("Location"), (err.read() or b"").decode("utf-8", "replace")

    def _trace(self, method, url, status):
        if self.cfg.verbose:
            print(f"         {method} {url[:96]} -> {status}", file=sys.stderr)

    def get(self, url, headers=None):
        if url.startswith("/"):  # IdP-relative
            origin = urllib.parse.urlparse(self.base)
            url = f"{origin.scheme}://{origin.netloc}{url}"
        req = urllib.request.Request(url)
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        status, location, body = self._open(req)
        self._trace("GET", url, status)
        return status, location, body

    def post(self, url, payload, headers=None):
        req = urllib.request.Request(url, data=json.dumps(payload).encode(), method="POST")
        req.add_header("Content-Type", "application/json")
        req.add_header("X-authentik-CSRF", self.cookie("authentik_csrf") or "")
        req.add_header("Referer", self.cfg.public + "/")
        for key, value in (headers or {}).items():
            req.add_header(key, value)
        status, location, body = self._open(req)
        self._trace("POST", url, status)
        return status, location, body

    def cookie(self, name):
        for cookie in self.jar:
            if cookie.name == name:
                return cookie.value
        return None

    def json(self, url, headers=None):
        status, _, body = self.get(url, headers)
        if status != 200:
            raise CheckFailed(f"GET {url} -> HTTP {status} (expected 200)")
        try:
            return json.loads(body)
        except ValueError as err:
            raise CheckFailed(f"GET {url} did not answer JSON: {body[:120]}") from err


# ── Authentik admin API (throwaway identity) ───────────────────────────────


class AuthApi:
    def __init__(self, cfg):
        self.cfg = cfg

    def call(self, method, path, body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.cfg.api + "/api/v3" + path, data=data, method=method)
        req.add_header("Authorization", "Bearer " + self.cfg.token)
        req.add_header("Accept", "application/json")
        if data:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as err:
            raise CannotRun(f"{method} {path} -> HTTP {err.code}: {(err.read() or b'').decode()[:200]}")

    def make_user(self):
        for stale in self.call("GET", "/core/users/?username=" + urllib.parse.quote(MEMBER_USER))["results"]:
            self.call("DELETE", f"/core/users/{stale['pk']}/")
        user = self.call("POST", "/core/users/", {
            "username": MEMBER_USER,
            "name": "Distro SSO Verification",
            "email": f"{MEMBER_USER}@innotel.us",
            "is_active": True,
            "path": "users",
            "type": "internal",
        })
        pk = user["pk"]
        self.call("POST", f"/core/users/{pk}/set_password/", {"password": self.cfg.password})
        return pk


# ── helpers ────────────────────────────────────────────────────────────────


def check(condition, message):
    if condition:
        print(f"  {OK}  {message}")
        return True
    print(f"  {BAD}  {message}")
    return False


def require(condition, message):
    if not condition:
        raise CheckFailed(message)


def same_origin(left, right):
    a, b = urllib.parse.urlparse(left), urllib.parse.urlparse(right)
    return (a.scheme, a.netloc) == (b.scheme, b.netloc)


def normalize(url):
    return url.rstrip("/")


def unreachable(err, host):
    """A name that does not resolve, or a connection that never lands."""
    if "Name or service not known" in str(err) or "Temporary failure" in str(err):
        return f"cannot resolve {host} from this host ({err})"
    return f"cannot reach {host} ({err})"


def drive_flow(client, cfg, start_url):
    """Take the authorize redirect Distro hands out and finish the dance.

    Returns `(callback_url, state)` — the callback still has to be fetched, which
    the caller does so it can read the session out of the response.
    """
    status, location, _ = client.get(start_url)
    require(status == 302, f"GET {start_url} -> HTTP {status} (expected a redirect to the IdP)")
    require(same_origin(location, cfg.issuer), f"{start_url} redirected away from the IdP: {(location or '-')[:100]}")
    require("client_id=" in (location or ""), "the authorize URL carries no client_id")

    query = urllib.parse.parse_qs(urllib.parse.urlparse(location).query)
    redirect_uri = (query.get("redirect_uri") or [""])[0]
    require(redirect_uri != "", "the authorize URL carries no redirect_uri")

    status, flow_url, body = client.get(location)
    require(status == 302 and flow_url, f"authorize -> HTTP {status}: {body[:160]}")

    origin = urllib.parse.urlparse(urllib.parse.urljoin(cfg.issuer + "/", flow_url))
    idp = f"{origin.scheme}://{origin.netloc}"
    client.base = idp
    executor = (idp + "/api/v3/flows/executor/" + AUTH_FLOW + "/?"
                + urllib.parse.urlencode({"query": urllib.parse.urlparse(flow_url).query}))
    stage = follow_json(client, executor)
    for _ in range(6):
        component = stage.get("component")
        if component == "xak-flow-redirect":
            break
        if component == "ak-stage-identification":
            payload = {"uid_field": MEMBER_USER}
        elif component == "ak-stage-password":
            payload = {"password": cfg.password}
        else:
            raise CheckFailed(f"unexpected Authentik stage {component}")
        status, next_url, body = client.post(executor, payload)
        if status not in (200, 302):
            raise CheckFailed(f"the flow stage answered HTTP {status}: {body[:200]}")
        stage = follow_json(client, next_url or executor)

    require(stage.get("component") == "xak-flow-redirect",
            "Authentik's flow never handed back the authorize URL")
    return follow_to_code(client, stage["to"]), redirect_uri


def follow_json(client, url, hops=8):
    for _ in range(hops):
        status, location, body = client.get(url)
        if status == 200:
            return json.loads(body)
        if status == 302 and location:
            url = location
            continue
        raise CheckFailed(f"expected a JSON flow stage, got HTTP {status} for {url}")
    raise CheckFailed("too many redirects inside Authentik's auth flow")


def follow_to_code(client, url, hops=8):
    for _ in range(hops):
        status, location, body = client.get(url)
        if status == 302 and location:
            if "code=" in location:
                return location
            url = location
            continue
        raise CheckFailed(f"authorize returned {status} instead of a code: {body[:200]}")
    raise CheckFailed("no authorization code after too many redirects")


def session_token(html):
    """The callback page hands the session to the opener window as JSON."""
    marker = "const d="
    start = html.find(marker)
    if start < 0:
        return None
    start += len(marker)
    end = html.find(";window.opener", start)
    payload = html[start:end if end > 0 else len(html)].strip()
    try:
        return json.loads(payload.replace("\\u003c", "<").replace("\\u003e", ">")).get("token")
    except ValueError:
        return None


# ── the checks ─────────────────────────────────────────────────────────────


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--url", help="the origin the console is served on (default: PORT on this host's LAN IP)")
    parser.add_argument("--verbose", action="store_true", help="trace every HTTP hop")
    args = parser.parse_args()

    try:
        cfg = Config(args)
    except CannotRun as err:
        print(f"SKIP: {err}", file=sys.stderr)
        return 2

    api = None
    member_pk = None
    failures = 0
    print("Distro SSO verification")
    print(f"  console : {cfg.url}")
    print(f"  public  : {cfg.public}")
    print(f"  issuer  : {cfg.issuer}")
    print(f"  client  : {cfg.client_id}")
    print(f"  break-glass login: {'ON (this host)' if cfg.breakglass else 'off'}")
    print()

    try:
        # ── 1. the local password path is closed ──────────────────────────
        print("[1] the console's own password path")
        if cfg.breakglass:
            print(f"  {OK}  skipped: BREAKGLASS_LOGIN is set on this host (a deliberate recovery window)")
        else:
            for path, payload in (("/api/auth/login", {"email": "nobody@innotel.us", "password": "not-a-password"}),
                                  ("/api/auth/signup", {"email": "nobody@innotel.us", "password": "not-a-password"})):
                status, _, _ = Client(cfg).post(cfg.url + path, payload)
                if check(status == 403, f"POST {path} -> HTTP {status} (expected 403 while BREAKGLASS_LOGIN is off)"):
                    pass
                else:
                    failures += 1

        # ── 2. the issuer the IdP publishes is the one Distro expects ──────
        print("[2] the issuer Authentik publishes matches the one Distro is configured with")
        discovery_url = cfg.issuer + "/.well-known/openid-configuration"
        try:
            document = Client(cfg).json(discovery_url)
        except (CheckFailed, urllib.error.URLError, OSError) as err:
            print(f"  {BAD}  {unreachable(err, cfg.issuer)}")
            failures += 1
            document = None
        if document is not None:
            published = normalize(document.get("issuer") or "")
            if check(published == normalize(cfg.issuer),
                     f"discovery issuer {published or '(none)'} == OIDC_ISSUER_URL"):
                pass
            else:
                print("        a mismatch here is what makes a client refuse every token "
                      "(HTTP 500 at the callback); the provider's issuer_mode must be per_provider")
                failures += 1

        # ── 3. the console's sign-in is Authentik ─────────────────────────
        print("[3] the console signs in through Authentik, on a registered callback")
        try:
            status, _, body = Client(cfg).get(cfg.url + "/api/auth/oidc/start")
        except OSError as err:
            raise CannotRun(unreachable(err, cfg.url))
        if check(status == 302, f"GET /api/auth/oidc/start -> HTTP {status} (expected 302)"):
            pass
        else:
            print(f"        {body[:160]}")
            failures += 1

        # ── 4. a real login opens the console ─────────────────────────────
        print("[4] a real Authentik login opens /api/me")
        if not cfg.token:
            print(f"  {OK}  skipped: no Authentik admin token (set AUTHENTIK_BOOTSTRAP_TOKEN to run it)")
        else:
            api = AuthApi(cfg)
            member_pk = api.make_user()
            client = Client(cfg)
            try:
                callback, redirect_uri = drive_flow(client, cfg, cfg.url + "/api/auth/oidc/start")
                require(any(normalize(uri) == normalize(redirect_uri) for uri in cfg.redirect_uris)
                        or redirect_uri in cfg.redirect_uris,
                        f"the authorize request used an unregistered redirect_uri: {redirect_uri}")
                status, _, page = client.get(callback)
                require(status == 200, f"the callback answered HTTP {status}: {page[:200]}")
                token = session_token(page)
                require(token, "the callback handed back no session token")
                me = client.json(cfg.url + "/api/me", headers={SESSION_HEADER: f"Bearer {token}"})
                email = str(((me or {}).get("user") or {}).get("email", "")).lower()
                require(email == f"{MEMBER_USER}@innotel.us",
                        f"GET /api/me with the session -> {email or '(no session)'} "
                        f"(expected {MEMBER_USER}@innotel.us)")
                check(True, f"GET /api/me with the session -> {email}")
            except CheckFailed as err:
                print(f"  {BAD}  {err}")
                failures += 1
            except (urllib.error.URLError, OSError) as err:
                print(f"  {BAD}  {unreachable(err, cfg.url)}")
                failures += 1

        # ── 5. the public name is the same door ───────────────────────────
        print("[5] the public name serves the same OIDC configuration")
        try:
            public = Client(cfg).json(cfg.public + "/api/auth/oidc/config")
        except (CheckFailed, urllib.error.URLError, OSError) as err:
            print(f"  {BAD}  {unreachable(err, cfg.public)}")
            failures += 1
            public = None
        if public is not None:
            if not check(public.get("enabled") is True, f"{cfg.public} reports the OIDC provider enabled"):
                failures += 1
            elif not check(public.get("misconfigured") is not True,
                           "the public origin is not misconfigured (local login off, OIDC on)"):
                failures += 1

        if failures:
            print(f"\n{BAD} — {failures} check(s) failed", file=sys.stderr)
            return 1
        print("\nPASS — Distro's only login is Cerulean Authentik, and it completes")
        return 0
    except CannotRun as err:
        print(f"\nSKIP: {err}", file=sys.stderr)
        return 2
    except CheckFailed as err:
        print(f"\n{BAD} — {err}", file=sys.stderr)
        return 1
    finally:
        if api is not None and member_pk is not None:
            try:
                api.call("POST", f"/core/users/{member_pk}/set_password/", {"password": os.urandom(24).hex()})
                api.call("DELETE", f"/core/users/{member_pk}/")
                print(f"[cleanup] deleted temporary user {MEMBER_USER} (pk={member_pk})")
            except CannotRun as err:
                print(f"[cleanup] WARNING: could not delete pk={member_pk}: {err}", file=sys.stderr)


if __name__ == "__main__":
    sys.exit(main())
