// Pi rewrites JSON whitespace/key order when saving settings; values still must match.
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

try {
  const [left, right] = process.argv.slice(2);
  process.exitCode = isDeepStrictEqual(
    JSON.parse(readFileSync(left, "utf8")),
    JSON.parse(readFileSync(right, "utf8")),
  ) ? 0 : 1;
} catch {
  // The caller reports the managed path, never potentially sensitive JSON text.
  process.exitCode = 1;
}
