/**
 * LOCAL gate/behaviour tests for the probe. NEVER deployed (only api/ ships).
 *
 * Run from the serverless-probe folder:   node tests/local-gates.mjs
 *
 * Proves the key gate, the phase separation, EVERY send-refusal gate and secret
 * hygiene. It makes real TCP/TLS connections to smtp.gmail.com plus two doomed
 * AUTH attempts - but it can NEVER deliver mail: it only ever sets a fake
 * SMTP_USER/SMTP_PASS, so even an accidental send would fail authentication.
 */
process.env.PROBE_KEY = "local-sanity-key-1234567890";
const { default: handler } = await import("../api/smtp-probe.mjs");

const makeRes = () => ({
  statusCode: null,
  body: null,
  headers: {},
  setHeader(k, v) {
    this.headers[k] = v;
  },
  status(c) {
    this.statusCode = c;
    return this;
  },
  json(p) {
    this.body = p;
    return this;
  },
});

const call = async ({ method = "GET", query = "", body = null, key = process.env.PROBE_KEY }) => {
  const res = makeRes();
  const headers = { host: "localhost" };
  if (key !== null) headers["x-probe-key"] = key;
  await handler({ method, url: `/api/smtp-probe${query}`, headers, body }, res);
  return res;
};

let pass = 0;
let fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) {
    pass += 1;
    console.log(`  PASS  ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${name}${detail ? ` :: ${detail}` : ""}`);
  }
};
const setEnv = (o) => {
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
};
const clearSendEnv = () =>
  setEnv({ PROBE_SEND_ENABLED: undefined, PROBE_ALLOWED_RECIPIENTS: undefined, SMTP_USER: undefined, SMTP_PASS: undefined });

console.log("\n[1] Key gate fails closed");
clearSendEnv();
let r = await call({ key: null });
check("no key -> 404", r.statusCode === 404, JSON.stringify(r.body));
r = await call({ key: "wrong" });
check("wrong key -> 404", r.statusCode === 404, JSON.stringify(r.body));

console.log("\n[2] Read-only probe: phases are separated");
r = await call({});
let b = r.body;
check("probe -> 200", r.statusCode === 200);
check(
  "connectivity block is TCP-only",
  Array.isArray(b?.connectivity?.ports) && b.connectivity.ports.length === 2 && b.connectivity.ports.every((p) => "tcpConnected" in p)
);
check("tls block carries handshake evidence", typeof b?.tls?.handshakeOk === "boolean" && "protocol" in b.tls, JSON.stringify(b?.tls));
check(
  "authentication block is separate",
  typeof b?.authentication?.configured === "boolean" && Array.isArray(b?.authentication?.results)
);
check("a probe request never sends", b?.sentRealEmail === false && b?.send?.requested === false, JSON.stringify(b?.send));
check("verdict mentions the tcp phase", typeof b?.verdict === "string" && /TCP OPEN|BLOCKED/.test(b.verdict), b?.verdict);

console.log("\n[3] Explicit-action guards");
r = await call({ method: "POST" });
check("POST without action -> 400 (never sends)", r.statusCode === 400 && r.body?.code === "unsupported-action", JSON.stringify(r.body));
r = await call({ query: "?action=send" });
check("GET action=send -> 400 send-requires-post", r.statusCode === 400 && r.body?.code === "send-requires-post");
r = await call({ query: "?action=nuke" });
check("unknown action -> 400 unsupported-action", r.statusCode === 400 && r.body?.code === "unsupported-action");

console.log("\n[4] Send gates must all block (nothing sent)");
clearSendEnv();
r = await call({ method: "POST", query: "?action=send", body: { to: "owner@example.com", confirm: "owner@example.com" } });
check("disabled by default -> 403 send-disabled", r.statusCode === 403 && r.body?.code === "send-disabled" && r.body?.send?.sentRealEmail === false);
setEnv({ PROBE_SEND_ENABLED: "true" });
r = await call({ method: "POST", query: "?action=send", body: { to: "owner@example.com", confirm: "owner@example.com" } });
check("enabled but no allow-list -> 403 no-allowlist", r.statusCode === 403 && r.body?.code === "no-allowlist");
setEnv({ PROBE_ALLOWED_RECIPIENTS: "owner@example.com" });
r = await call({ method: "POST", query: "?action=send", body: { to: "a@x.com,b@y.com", confirm: "a@x.com,b@y.com" } });
check("multi-recipient -> 400 invalid-recipient", r.statusCode === 400 && r.body?.code === "invalid-recipient");
r = await call({ method: "POST", query: "?action=send", body: { to: "stranger@example.com", confirm: "stranger@example.com" } });
check("not allow-listed -> 403 recipient-not-allowed", r.statusCode === 403 && r.body?.code === "recipient-not-allowed");
r = await call({ method: "POST", query: "?action=send", body: { to: "owner@example.com", confirm: "nope" } });
check("confirm mismatch -> 400 confirmation-required", r.statusCode === 400 && r.body?.code === "confirmation-required");

console.log(`\n[5] Auth path with DUMMY credentials (no email sent)\n`);
setEnv({ SMTP_USER: "probe-dummy-not-real@example.com", SMTP_PASS: "dummy-password-not-real" });
r = await call({});
const auth = r.body?.authentication;
const dumped = JSON.stringify(r.body);
check("AUTH attempted when creds exist", auth?.configured === true && auth?.attempted === true, JSON.stringify(auth));
check("per-port results present", Array.isArray(auth?.results) && auth.results.length === 2, JSON.stringify(auth?.results));
check("results carry ok/code/ms", auth.results.every((x) => "ms" in x && ("ok" in x || x.attempted === false)));
check("dummy creds are NOT accepted", auth?.ok === false);
check("password never appears in the response", dumped.indexOf("dummy-password-not-real") === -1);
check("username is stripped too", dumped.indexOf("probe-dummy-not-real") === -1, dumped.slice(0, 400));
check("PROBE_KEY value never echoed", dumped.indexOf(process.env.PROBE_KEY) === -1);
check("no stack traces in the response", dumped.indexOf("    at ") === -1 && dumped.indexOf("node_modules") === -1);

console.log("\n==================================================");
console.log(`  passed: ${pass}   failed: ${fail}`);
if (fail) console.log(`  failures: ${fail}`);
process.exit(fail ? 1 : 0);
