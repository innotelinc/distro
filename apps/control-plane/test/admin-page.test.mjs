import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import vm from "node:vm";

/**
 * The admin console's one inline script.
 *
 * This is a page shipped as static HTML with a single `<script>` block, so a
 * syntax error anywhere in it is not a broken function — it is a dead console:
 * the browser never executes a byte of it, `bootLogin()` never runs, and the
 * login card sits there with the "Continue with Authentik" button still hidden
 * in the markup. That is exactly how the console was found live in September
 * 2026 (a duplicated guard left an unbalanced `}` in `renderBuildQueue`), and
 * nothing in the test suite noticed, because node never parses this file.
 *
 * So the page is parsed here the way a browser would: compile the inline
 * script, and check the elements the script wires up actually exist. Both are
 * cheap and both fail loudly on the mistake that was made.
 */

const html = readFileSync(
  join(dirname(new URL(import.meta.url).pathname), "..", "src", "admin.html"),
  "utf8",
);

function inlineScript() {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, "src/admin.html has no inline <script> block");
  return match[1];
}

const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

test("the admin console's inline script compiles", () => {
  // `new vm.Script` parses without running, which is the whole check: the page
  // has to be executable in the browser, not merely present.
  assert.doesNotThrow(
    () => new vm.Script(inlineScript(), { filename: "admin.html" }),
    "the inline script in src/admin.html has a syntax error — the console would render with no JavaScript at all",
  );
});

test("every element the admin script binds a handler to exists", () => {
  const script = inlineScript();
  const referenced = new Set(
    [...script.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
  );
  const missing = [...referenced].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `handler bound to missing element id(s): ${missing.join(", ")}`);
});

test("the login card ships SSO-only", () => {
  // Identity is Cerulean Authentik. The password form is break-glass only, so
  // it must arrive hidden and be revealed at runtime (BREAKGLASS_LOGIN=1).
  const script = inlineScript();
  assert.match(
    html,
    /<button id="oidcBtn" class="hidden"[^>]*>Continue with Authentik<\/button>/,
    "the Authentik button must exist and start hidden (bootLogin reveals it)",
  );
  assert.match(
    html,
    /<div id="localLoginBlock" class="hidden">/,
    "the local password form must start hidden",
  );
  assert.match(script, /sso\.onclick = openOidc;/);
  assert.doesNotMatch(
    html,
    /<input id="password"[^>]*>\s*<button id="loginBtn" style="width:100%">Sign in<\/button>\s*<\/div>\s*<div class="err"/,
    "the password form must not be rendered outside the break-glass block",
  );
});
