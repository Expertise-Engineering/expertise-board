import assert from "node:assert/strict";
import test from "node:test";
import { displayNameFromEmail, isAllowedEmail, safeNextPath } from "./email.ts";

test("accepts only exp-eng.com addresses", () => {
  assert.equal(isAllowedEmail("ada@exp-eng.com"), true);
  assert.equal(isAllowedEmail(" Ada.Lovelace@EXP-ENG.com "), true);
  assert.equal(isAllowedEmail("ada+board@exp-eng.com"), true);
  assert.equal(isAllowedEmail("ada@exp-eng.com.evil.com"), false);
  assert.equal(isAllowedEmail("ada@notexp-eng.com"), false);
  assert.equal(isAllowedEmail("ada@exp-eng.co"), false);
  assert.equal(isAllowedEmail("@exp-eng.com"), false);
  assert.equal(isAllowedEmail("ada"), false);
});

test("display name is the email local-part", () => {
  assert.equal(displayNameFromEmail("Ada.Lovelace@exp-eng.com"), "ada.lovelace");
});

test("next paths stay on this site", () => {
  assert.equal(safeNextPath("/projects/acme"), "/projects/acme");
  assert.equal(safeNextPath("https://evil.example"), "/");
  assert.equal(safeNextPath("//evil.example"), "/");
  assert.equal(safeNextPath(null), "/");
});
