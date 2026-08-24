// pi's extension loader resolves "./x.js" to x.ts; Node's native type
// stripping does not. This hook makes plain `node` behave the same.
export async function resolve(specifier, context, next) {
  if (specifier.startsWith(".") && specifier.endsWith(".js")) {
    try { return await next(specifier.slice(0, -3) + ".ts", context); } catch { /* fall through */ }
  }
  return next(specifier, context);
}
