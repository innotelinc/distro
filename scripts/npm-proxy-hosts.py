#!/usr/bin/env python3
"""
npm-proxy-hosts.py — provision Nginx Proxy Manager proxy hosts + wildcard SSL.

Creates the Distro subdomains on an Nginx Proxy Manager instance via its API:

    slots.<DOMAIN>      -> http://127.0.0.1:5173  (Distro web app)
    admin.<DOMAIN>      -> http://127.0.0.1:20140 (control plane /admin)
    cp.<DOMAIN>         -> http://127.0.0.1:20140 (control plane API under /cp)
    gateway.<DOMAIN>    -> http://127.0.0.1:20128 (OmniRoute dashboard, private)

A wildcard Let's Encrypt certificate ( *.DOMAIN + DOMAIN ) is issued via the
DNS challenge so every subdomain gets SSL automatically. Requires NPM >= 2.11
(dns challenge support) and DNS credentials for your provider.

Configuration (env vars, see .env):
    NPM_API_URL           e.g. https://npm.example.com/api
    NPM_API_IDENTITY      NPM login
    NPM_API_SECRET        NPM password
    DOMAIN                base domain, e.g. innotel.us
    NPM_DNS_PROVIDER      certbot-style provider id, e.g. cloudflare
    NPM_DNS_EMAIL         account e-mail for the DNS provider
    NPM_DNS_CREDENTIALS   JSON object of provider credentials
    NPM_HOSTS_JSON        (optional) JSON override for the host map

Only stdlib — run with:  python3 scripts/npm-proxy-hosts.py
"""

import json
import os
import sys
import urllib.error
import urllib.request

# ---------------------------------------------------------------- config

def env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()

NPM_API_URL = env("NPM_API_URL").rstrip("/")
NPM_IDENTITY = env("NPM_API_IDENTITY")
NPM_SECRET = env("NPM_API_SECRET")
DOMAIN = env("DOMAIN")
DNS_PROVIDER = env("NPM_DNS_PROVIDER", "cloudflare")
DNS_EMAIL = env("NPM_DNS_EMAIL")
DNS_CREDENTIALS_RAW = env("NPM_DNS_CREDENTIALS", "{}")
HOSTS_JSON = env("NPM_HOSTS_JSON", "")

DEFAULT_HOSTS = [
    {"subdomain": "slots", "forward_host": "127.0.0.1", "forward_port": 5173, "ssl": True},
    {"subdomain": "admin", "forward_host": "127.0.0.1", "forward_port": 20140, "ssl": True},
    {"subdomain": "cp", "forward_host": "127.0.0.1", "forward_port": 20140, "ssl": True},
    {"subdomain": "gateway", "forward_host": "127.0.0.1", "forward_port": 20128, "ssl": True, "private": True},
]

def load_hosts() -> list:
    if HOSTS_JSON:
        try:
            parsed = json.loads(HOSTS_JSON)
            if isinstance(parsed, list) and parsed:
                return parsed
            print("warning: NPM_HOSTS_JSON is not a non-empty list — using defaults",
                  file=sys.stderr)
        except json.JSONDecodeError as exc:
            print(f"warning: NPM_HOSTS_JSON is invalid JSON ({exc}) — using defaults",
                  file=sys.stderr)
    return DEFAULT_HOSTS

# ---------------------------------------------------------------- http

def api_call(method: str, path: str, body=None) -> dict:
    url = f"{NPM_API_URL}{path}"
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("Content-Type", "application/json")
    req.add_header("Accept", "application/json")
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as exc:
        print(f"API error {exc.code}: {exc.read().decode()[:200]}", file=sys.stderr)
        raise

# ---------------------------------------------------------------- auth

def npm_login() -> str:
    resp = api_call("POST", "/api/tokens", {
        "identity": NPM_IDENTITY,
        "secret": NPM_SECRET,
    })
    token = resp.get("token")
    if not token:
        raise RuntimeError(f"login failed: {resp}")
    return token

def npm_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Accept": "application/json"}

def npm_get(token: str, path: str) -> dict:
    url = f"{NPM_API_URL}{path}"
    req = urllib.request.Request(url)
    for k, v in npm_headers(token).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def npm_post(token: str, path: str, body: dict) -> dict:
    url = f"{NPM_API_URL}{path}"
    data = json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    for k, v in npm_headers(token).items():
        req.add_header(k, v)
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

# ---------------------------------------------------------------- main

def main():
    missing = []
    for var in ["NPM_API_URL", "NPM_API_IDENTITY", "NPM_API_SECRET", "DOMAIN"]:
        if not globals()[var]:
            missing.append(var)
    if missing:
        print(f"missing required env vars: {', '.join(missing)}", file=sys.stderr)
        sys.exit(1)

    hosts = load_hosts()
    dns_creds = json.loads(DNS_CREDENTIALS_RAW) if DNS_CREDENTIALS_RAW else {}

    print(f"==> logging in to NPM at {NPM_API_URL}")
    token = npm_login()
    print("    ✓ authenticated")

    # Find or create wildcard certificate
    print(f"==> checking for wildcard cert (*.{DOMAIN})")
    certs = npm_get(token, "/api/nginx/certificates") if hasattr(npm_get, '__call__') else []
    if isinstance(certs, dict):
        certs = certs.get("certificates", [])

    wildcard_id = None
    for cert in certs:
        names = cert.get("domain_names", [])
        if f"*.{DOMAIN}" in names and DOMAIN in names:
            wildcard_id = cert["id"]
            print(f"    ✓ found existing cert #{wildcard_id}")
            break

    if not wildcard_id:
        print(f"    → requesting new wildcard cert via DNS challenge ({DNS_PROVIDER})")
        cert_body = {
            "domain_names": [f"*.{DOMAIN}", DOMAIN],
            "meta": {
                "letsencrypt_email": DNS_EMAIL,
                "dns_provider": DNS_PROVIDER,
                "dns_credentials": dns_creds,
            },
            "type": "Wildcard",
        }
        cert = npm_post(token, "/api/nginx/certificates", cert_body)
        wildcard_id = cert.get("id")
        print(f"    ✓ cert #{wildcard_id} issued")

    # Create proxy hosts
    print(f"==> creating {len(hosts)} proxy host(s)")
    for h in hosts:
        subdomain = h["subdomain"]
        hostname = f"{subdomain}.{DOMAIN}"
        fwd_host = h.get("forward_host", "127.0.0.1")
        fwd_port = h.get("forward_port", 5173)
        use_ssl = h.get("ssl", True)
        is_private = h.get("private", False)

        host_body = {
            "domain_names": [hostname],
            "forward_host": fwd_host,
            "forward_port": fwd_port,
            "forward_scheme": "http",
            "ssl_forced": use_ssl,
            "hsts_enabled": use_ssl,
            "http2_support": use_ssl,
            "block_exploits": True,
            "advanced_config": "",
            "allow_websocket_upgrade": True,
            "access_list_id": 0,
            "certificate_id": wildcard_id if use_ssl else 0,
            "meta": {"letsencrypt_email": DNS_EMAIL, "nginx_online": True},
        }

        try:
            # Check if host already exists
            existing = npm_get(token, f"/api/nginx/proxy-hosts")
            if isinstance(existing, dict):
                existing = existing.get("proxy_hosts", [])
            found = False
            for eh in existing:
                if hostname in eh.get("domain_names", []):
                    found = True
                    print(f"    {hostname} → already exists (#{eh['id']}), skipping")
                    break
            if not found:
                result = npm_post(token, "/api/nginx/proxy-hosts", host_body)
                print(f"    {hostname} → {fwd_host}:{fwd_port} (#{result.get('id', '?')})")
        except Exception as exc:
            print(f"    {hostname} → ERROR: {exc}", file=sys.stderr)

    print(f"\n==> done! Proxied hosts:")
    for h in hosts:
        proto = "https" if h.get("ssl") else "http"
        print(f"    {proto}://{h['subdomain']}.{DOMAIN} → :{h.get('forward_port', 5173)}")


if __name__ == "__main__":
    main()
