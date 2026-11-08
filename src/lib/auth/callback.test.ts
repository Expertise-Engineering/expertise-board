import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyAuthCallback,
  confirmPath,
  credentialParamsFromEntries,
  isTrustedAuthPost,
  loginErrorForAuthFailure,
  loginErrorMessage,
  planAuthCallback,
} from "./callback.ts";

const TOKEN = "a".repeat(48);

test("GET and HEAD of a token_hash link do not consume it", () => {
  const params = new URLSearchParams({ token_hash: TOKEN, type: "email", next: "/projects/acme" });
  for (const method of ["GET", "HEAD"] as const) {
    const plan = planAuthCallback(method, params);
    assert.equal(plan.consume, false);
    if (!plan.consume) {
      assert.equal(plan.location.startsWith("/auth/confirm?"), true);
      assert.equal(plan.location.includes("token_hash="), true);
      assert.equal(plan.location.includes("/verify"), false);
    }
  }

  const post = planAuthCallback("POST", params);
  assert.equal(post.consume, true);
  if (post.consume) {
    assert.equal(post.decision.method, "otp");
    assert.equal(post.decision.otpType, "email");
    assert.equal(post.decision.next, "/projects/acme");
  }
});

test("magiclink and signup token hashes reach the confirm page", () => {
  for (const type of ["magiclink", "signup", "invite", "recovery", "email_change", "EMAIL"]) {
    const decision = classifyAuthCallback(new URLSearchParams({ token_hash: TOKEN, type }));
    assert.equal(decision.action, "confirm");
    assert.equal(decision.method, "otp");
    if (decision.method === "otp") assert.equal(decision.otpType, type.toLowerCase());
  }
});

test("a PKCE code is confirmed on POST and not exchanged on GET", () => {
  const params = new URLSearchParams({ code: "pkce-code-value" });
  const get = planAuthCallback("GET", params);
  assert.equal(get.consume, false);
  const post = planAuthCallback("POST", params);
  assert.equal(post.consume, true);
  if (post.consume) assert.equal(post.decision.method, "code");
});

test("token_hash wins when a code is also present", () => {
  const decision = classifyAuthCallback(new URLSearchParams({ token_hash: TOKEN, type: "email", code: "pkce-code-value" }));
  assert.equal(decision.action, "confirm");
  if (decision.action === "confirm") assert.equal(decision.method, "otp");
});

test("expired and used links get a specific login error", () => {
  const cases = [
    new URLSearchParams({ error: "access_denied", error_code: "otp_expired", error_description: "Email link is invalid or has expired" }),
    new URLSearchParams({ error_code: "flow_state_expired" }),
    new URLSearchParams({ error_code: "flow_state_not_found" }),
    new URLSearchParams({ error_description: "One-time token not found" }),
  ];
  for (const params of cases) {
    const plan = planAuthCallback("GET", params);
    assert.equal(plan.consume, false);
    if (!plan.consume) assert.equal(plan.location, "/login?error=expired");
  }

  assert.equal(loginErrorForAuthFailure({ code: "otp_expired", message: "Email link is invalid or has expired" }), "expired");
  assert.equal(loginErrorForAuthFailure({ message: "Token has expired or is invalid" }), "expired");
});

test("a missing PKCE verifier is not reported as an expired link", () => {
  assert.equal(loginErrorForAuthFailure({ code: "bad_code_verifier" }), "pkce");
  assert.equal(
    loginErrorForAuthFailure({ message: "both auth code and code verifier should be non-empty" }),
    "pkce",
  );
  assert.equal(loginErrorMessage("expired"), "That magic link has expired or was already used. Request a new one.");
  assert.equal(loginErrorMessage("pkce")?.includes("browser that requested it"), true);
  assert.equal(loginErrorMessage("nope"), "Sign-in failed.");
});

test("missing, unknown, and hostile callback params do not confirm", () => {
  const rejected = [
    new URLSearchParams(),
    new URLSearchParams({ token_hash: TOKEN }),
    new URLSearchParams({ type: "email" }),
    new URLSearchParams({ token_hash: TOKEN, type: "phone" }),
    new URLSearchParams({ token_hash: "short", type: "email" }),
    new URLSearchParams({ token_hash: `${TOKEN}<script>`, type: "email" }),
    new URLSearchParams({ token_hash: `${TOKEN}\nset-cookie`, type: "email" }),
    new URLSearchParams({ error: "access_denied" }),
    new URLSearchParams({ code: "bad" }),
  ];
  for (const params of rejected) {
    const plan = planAuthCallback("POST", params);
    assert.equal(plan.consume, false);
    if (!plan.consume) assert.match(plan.location, /^\/login\?error=(auth|expired)$/);
  }
});

test("confirm links keep a safe next path and drop external redirects", () => {
  const decision = classifyAuthCallback(
    new URLSearchParams({ token_hash: TOKEN, type: "email", next: "https://evil.example" }),
  );
  assert.equal(decision.action, "confirm");
  if (decision.action === "confirm") {
    assert.equal(decision.next, "/");
    assert.equal(confirmPath(decision).includes("next="), false);
  }

  const relative = classifyAuthCallback(new URLSearchParams({ code: "pkce-code-value", next: "/projects/acme" }));
  if (relative.action === "confirm") {
    assert.equal(confirmPath(relative), "/auth/confirm?code=pkce-code-value&next=%2Fprojects%2Facme");
  }
});

test("form posts ignore query-only credentials and extra fields", () => {
  const params = credentialParamsFromEntries([
    ["token_hash", TOKEN],
    ["type", "email"],
    ["error_code", "otp_expired"],
    ["token_hash", "second-value-ignored"],
    ["next", "//evil.example"],
  ]);
  assert.equal(params.get("error_code"), null);
  assert.equal(params.get("token_hash"), TOKEN);
  const plan = planAuthCallback("POST", params);
  assert.equal(plan.consume, true);
  if (plan.consume && plan.decision.method === "otp") assert.equal(plan.decision.next, "/");
});

test("confirmation posts must come from this site", () => {
  const url = "https://expertise-board.netlify.app/auth/callback";
  const headers = { referer: null, host: "expertise-board.netlify.app", secFetchSite: "same-origin" as string | null };
  assert.equal(isTrustedAuthPost(url, { ...headers, origin: "https://expertise-board.netlify.app" }), true);
  assert.equal(
    isTrustedAuthPost(url, { origin: "https://evil.example", referer: null, host: "expertise-board.netlify.app", secFetchSite: "cross-site" }),
    false,
  );
  assert.equal(
    isTrustedAuthPost(url, { origin: "https://expertise-board.netlify.app", referer: null, host: null, secFetchSite: "cross-site" }),
    false,
  );
  assert.equal(
    isTrustedAuthPost(url, {
      origin: null,
      referer: "https://expertise-board.netlify.app/auth/confirm?token_hash=abc",
      host: null,
      secFetchSite: null,
    }),
    true,
  );
  assert.equal(isTrustedAuthPost(url, { origin: null, referer: null, host: null, secFetchSite: null }), false);
  assert.equal(isTrustedAuthPost(url, { origin: null, referer: null, host: null, secFetchSite: "none" }), false);
  assert.equal(
    isTrustedAuthPost(url, { origin: "null", referer: null, host: "expertise-board.netlify.app", secFetchSite: "same-origin" }),
    true,
  );
  assert.equal(
    isTrustedAuthPost("http://localhost:3000/auth/callback", {
      origin: "http://127.0.0.1:3000",
      referer: null,
      host: "127.0.0.1:3000",
      secFetchSite: "same-origin",
    }),
    true,
  );
});
