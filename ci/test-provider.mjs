// Checks ci/provider.mjs — the one place that knows which model writes the copy.
// Strictly offline: the only provider exercised here is "stub". The point of this check
// is the CONTRACT (returns n strings, survives a failing call, refuses to start without
// credentials), not any vendor's API.

import assert from "node:assert";
import { makeProvider } from "./provider.mjs";

// --- stub: offline, deterministic ------------------------------------------------
{
  const gen = makeProvider({ POST_PROVIDER: "stub" });
  const out = await gen({ system: "s", prompt: "p", n: 4 });
  assert.equal(out.length, 4, "the stub returns exactly n candidates");
  assert.ok(out.every((s) => typeof s === "string" && s.length > 0), "every candidate is a non-empty string");
  const again = await gen({ system: "s", prompt: "p", n: 4 });
  assert.deepEqual(out, again, "the stub is deterministic");
}

// --- credentials are required up front, not at call time -------------------------
assert.throws(
  () => makeProvider({ POST_PROVIDER: "cloudflare" }),
  /CF_ACCOUNT_ID|CF_API_TOKEN/,
  "cloudflare without credentials fails loudly at construction",
);
assert.throws(
  () => makeProvider({ POST_PROVIDER: "anthropic" }),
  /ANTHROPIC_API_KEY/,
  "anthropic without a key fails loudly at construction",
);
assert.throws(
  () => makeProvider({ POST_PROVIDER: "nope" }),
  /unknown provider/i,
  "an unknown provider name is rejected",
);

// --- a provider that is configured constructs fine --------------------------------
assert.doesNotThrow(
  () => makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }),
  "configured cloudflare constructs without touching the network",
);

// --- one failing call must not sink the batch (throw path) -------------------------
{
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 2) throw new Error("simulated 500");
    return { ok: true, json: async () => ({ result: { response: `candidate ${call}` } }) };
  };
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const out = await gen({ system: "s", prompt: "p", n: 3 });
  assert.equal(out.length, 2, "two of three calls succeeded and the batch survived");
}

// --- http error responses are handled (res.ok === false) ---------------------------
{
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 2) return { ok: false, status: 429 };
    return { ok: true, json: async () => ({ result: { response: `candidate ${call}` } }) };
  };
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const out = await gen({ system: "s", prompt: "p", n: 3 });
  assert.equal(out.length, 2, "429 error is caught and dropped; successful calls are kept");
}

// --- anthropic response shape is extracted correctly --------------------------------
{
  const fetchImpl = async () => {
    return {
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "anthropic candidate" }] }),
    };
  };
  const gen = makeProvider({ POST_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "key" }, fetchImpl);
  const out = await gen({ system: "s", prompt: "p", n: 1 });
  assert.equal(out.length, 1, "anthropic call succeeds");
  assert.equal(out[0], "anthropic candidate", "anthropic content[0].text is extracted correctly");
}

console.log("provider OK — stub determinism, credential guards, partial-failure tolerance, http errors, anthropic shape");
