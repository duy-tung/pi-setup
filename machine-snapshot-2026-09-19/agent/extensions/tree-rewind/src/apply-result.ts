export function applySucceeded(result: { errors: unknown[] } | null): boolean {
  return result !== null && result.errors.length === 0;
}
