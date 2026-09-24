// Checks ci/provider.mjs — the one place that knows which model writes the copy.
// Strictly offline: the only provider exercised here is "stub". The point of this check
// is the CONTRACT (returns n strings, survives a failing call, refuses to start without
// credentials), not any vendor's API.

import assert from "node:assert";
import { makeProvider } from "./provider.mjs";
import { isExhausted, resetForTest } from "./cf-budget.mjs";

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
// Non-ok responses must never be consumed as model output, even if they contain a parseable
// payload. We inject a 429 with a cloudflare-shaped success body to catch the case where
// the res.ok guard is deleted: without it, the error body would be extracted and leak through.
{
  let call = 0;
  const fetchImpl = async () => {
    call++;
    if (call === 2) return { ok: false, status: 429, json: async () => ({ result: { response: "ERROR BODY LEAKED" } }) };
    return { ok: true, json: async () => ({ result: { response: `candidate ${call}` } }) };
  };
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const out = await gen({ system: "s", prompt: "p", n: 3 });
  assert.equal(out.length, 2, "two of three calls succeeded; 429 is dropped");
  assert.ok(!out.some((c) => c.includes("ERROR BODY LEAKED")), "error bodies never leak into output");
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

// --- (Neuron accounting) onUsage fires once per SUCCESSFUL call, with the real usage object --
resetForTest();
{
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ result: { response: "candidate", usage: { prompt_tokens: 120, completion_tokens: 8 } } }),
  });
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const seen = [];
  const out = await gen({ system: "s", prompt: "p", n: 3, onUsage: (usage) => seen.push(usage) });
  assert.equal(out.length, 3, "all three candidates still succeed");
  assert.equal(seen.length, 3, "onUsage fires once per successful call");
  assert.deepEqual(seen[0], { prompt_tokens: 120, completion_tokens: 8 }, "the exact usage object is passed through untouched");
}
{
  // A response with NO usage field at all must not throw — onUsage still fires, with undefined.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { response: "candidate" } }) });
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const seen = [];
  await gen({ system: "s", prompt: "p", n: 1, onUsage: (usage) => seen.push(usage) });
  assert.equal(seen.length, 1, "onUsage still fires when usage itself is missing");
  assert.equal(seen[0], undefined, "and is handed exactly undefined, never a guessed default");
}
{
  // A FAILED candidate never fires onUsage — it was never billed, there is nothing to record.
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const seen = [];
  const out = await gen({ system: "s", prompt: "p", n: 2, onUsage: (usage) => seen.push(usage) });
  assert.equal(out.length, 0, "both candidates fail");
  assert.equal(seen.length, 0, "a failed candidate never calls onUsage");
}
{
  // onUsage is simply optional — omitting it must not throw.
  const fetchImpl = async () => ({ ok: true, json: async () => ({ result: { response: "candidate" } }) });
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  await assert.doesNotReject(() => gen({ system: "s", prompt: "p", n: 1 }), "no onUsage handler at all is fine");
}
resetForTest();
console.log("provider onUsage OK — fires once per successful call with the real (possibly undefined) usage object, never for a failure");

// --- (Neuron accounting) exhaustion: code 4006 is detected, logged ONCE, and short-circuits ---
resetForTest();
{
  // Cloudflare's real documented error shape for a 429.
  const exhaustedBody = { success: false, errors: [{ code: 4006, message: "you have used up your daily free allocation of 10,000 neurons" }] };
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => exhaustedBody });
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);

  let logs = [];
  const realError = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  let out;
  try {
    out = await gen({ system: "s", prompt: "p", n: 5 });
  } finally {
    console.error = realError;
  }
  assert.equal(out.length, 0, "an exhausted account yields zero candidates, not a thrown exception");
  assert.equal(isExhausted(), true, "the shared flag is now set");
  const exhaustionLines = logs.filter((l) => /4006/.test(l));
  assert.equal(exhaustionLines.length, 1, "FIVE identical 429s produce exactly ONE exhaustion line, not five");
  assert.equal(logs.some((l) => /candidate failed/.test(l)), false,
    "the generic per-candidate failure line never fires for the exhaustion case — that noise is exactly what this replaces");
}
{
  // Once exhausted, a SECOND call round does not even touch the network.
  let fetchCalls = 0;
  const fetchImpl = async () => { fetchCalls++; return { ok: true, json: async () => ({ result: { response: "x" } }) }; };
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  const out = await gen({ system: "s", prompt: "p", n: 3 });
  assert.equal(out.length, 0, "no candidates once the account is known-exhausted");
  assert.equal(fetchCalls, 0, "not even one network call is made — there is no point");
}
resetForTest();
{
  // A generic 429 with NO code 4006 is NOT treated as exhaustion — it still logs per-candidate,
  // same as any other transient failure, and does not flip the shared flag.
  const fetchImpl = async () => ({ ok: false, status: 429, json: async () => ({ errors: [{ code: 4029, message: "rate limited" }] }) });
  const gen = makeProvider({ POST_PROVIDER: "cloudflare", CF_ACCOUNT_ID: "a", CF_API_TOKEN: "t" }, fetchImpl);
  await gen({ system: "s", prompt: "p", n: 1 });
  assert.equal(isExhausted(), false, "a different Cloudflare error code never triggers the exhaustion flag");
}
resetForTest();
console.log("provider exhaustion OK — code 4006 logs once (not five times), short-circuits further calls, and is never confused with a generic rate limit");

console.log("provider OK — stub determinism, credential guards, partial-failure tolerance, http errors, anthropic shape");
