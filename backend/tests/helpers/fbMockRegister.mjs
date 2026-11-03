/**
 * Test-only Firebase Admin loader registration (Stage B).
 *
 * Loaded ONLY via NODE_OPTIONS=--import in spawned test-backend processes.
 * It registers a resolve hook that redirects `import("firebase-admin")` to the
 * local mock implementation. Production code is untouched: without this env
 * injection the server imports the real SDK exactly as before.
 */
import { register } from "node:module";

register("./fbMockHooks.mjs", import.meta.url);
