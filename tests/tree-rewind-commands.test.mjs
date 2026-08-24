import test from "node:test";
import assert from "node:assert/strict";

import { applySucceeded } from "../extensions/tree-rewind/src/apply-result.ts";

const base = { restored: 0, deleted: 0, skipped: [], errors: [] };

test("conversation navigation is allowed only after a non-null error-free file apply", () => {
  assert.equal(applySucceeded(null), false);
  assert.equal(applySucceeded({ ...base, errors: ["refused write"] }), false);
  assert.equal(applySucceeded({ ...base, skipped: [{ action: "unprotected" }] }), true);
  assert.equal(applySucceeded(base), true);
});
