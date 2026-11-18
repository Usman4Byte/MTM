import assert from "node:assert/strict";
import { test } from "node:test";
import { isGrounded } from "../src/lib/numbers";

test("a misread money figure is caught (800 read as 80000)", () => {
  const msg = "Standard lunch box ab Rs 1,200 per head hoga, basic wala Rs 800.";
  assert.equal(isGrounded(800, msg), true);
  assert.equal(isGrounded(1200, msg), true);
  assert.equal(isGrounded(80000, msg), false);
  assert.equal(isGrounded(12000, msg), false);
});

test("scaled forms are accepted", () => {
  assert.equal(isGrounded(650000, "budget is 6.5 lakh"), true);
  assert.equal(isGrounded(50000, "DJ quote 50k"), true);
  assert.equal(isGrounded(2000000, "sponsor gives 2 million"), true);
  assert.equal(isGrounded(14500000, "Budget is 14,500,000"), true);
});
