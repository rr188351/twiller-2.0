/**
 * Test-only Firebase Admin mock (Stage B).
 *
 * Shape-compatible with the tiny surface `backend/utils/firebaseAdmin.js`
 * uses: default export with `apps`, `initializeApp()`, `credential.cert()`,
 * and an app whose `.auth().verifyIdToken(token)` resolves test identities.
 *
 * Token -> identity mapping is read from the JSON file at
 * `MOCK_FIREBASE_MAP_PATH` ON EVERY CALL, so the suite can rewrite scenarios
 * without restarting the backend. Unknown tokens throw (=> 401 auth-invalid).
 * Shaped entries: { "<token>": { uid, email, email_verified } }.
 * An entry may omit `email` / `email_verified` to exercise those branches.
 */
import fs from "node:fs";

function loadMap() {
  try {
    const raw = fs.readFileSync(process.env.MOCK_FIREBASE_MAP_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const authService = {
  async verifyIdToken(token) {
    const entry = loadMap()[String(token)];
    if (!entry || typeof entry !== "object") {
      const err = new Error("mock: unknown or expired token");
      err.code = "auth/id-token-expired";
      throw err;
    }
    const out = { uid: entry.uid };
    if (entry.email !== undefined) out.email = entry.email;
    if (entry.email_verified !== undefined) out.email_verified = entry.email_verified;
    return out;
  },
};

const app = { auth: () => authService };

const admin = {
  apps: [],
  initializeApp() {
    admin.apps.push(app);
    return app;
  },
  credential: { cert: () => ({}) },
  SDK_VERSION: "mock-13.5.0",
};

export default admin;
