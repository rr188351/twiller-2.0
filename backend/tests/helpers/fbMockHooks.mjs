/**
 * Test-only module resolve hook (Stage B). Redirects the bare specifier
 * `firebase-admin` to the mock implementation file. Every other specifier
 * passes through untouched.
 */
export async function resolve(specifier, context, next) {
  if (specifier === "firebase-admin") {
    return {
      url: new URL("./mockFirebaseAdminImpl.mjs", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return next(specifier, context);
}
