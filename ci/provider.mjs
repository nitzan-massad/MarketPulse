// WHO WRITES THE COPY — one switch, so swapping models is an env var, not a refactor.
//
// Default is Cloudflare Workers AI because it is free: 10,000 neurons/day. The default MODEL
// is `@cf/meta/llama-3.3-70b-instruct-fp8-fast`, not the 8B instruct model this used to run —
// an 8B model writing an 8-word headline has a low ceiling on wit, which was the root cause of
// the flat, repetitive copy that kept getting flagged, and side-by-side generations against
// the same hooks (see the task's own report) showed the 70B model consistently punchier and
// less generic at the same temperature. `CF_MODEL` still overrides this either way. NOTE: the
// "roughly 15%" neuron-budget estimate above was measured against the 8B model — a 70B model
// is charged more neurons per token on Cloudflare's pricing, so that fraction is now a
// LOWER bound, not a fresh measurement; watch actual usage after this ships, and drop back to
// a smaller model (or lower POST_CANDIDATES) if the free daily allowance starts getting tight.
// "anthropic" is here as the quality escape hatch (~$0.30/mo at this volume) for an A/B.
// "stub" is what `npm test` uses — no network in checks, ever.
//
// ponytail: a plain switch, not a class hierarchy. Three providers, one function each.
//
// (Neuron accounting) `onUsage`, an optional extra field on every call's options object
// (`{ system, prompt, n, onUsage }`), fires once per SUCCESSFUL Cloudflare call with exactly
// whatever that response's `result.usage` was (possibly `undefined` — see ci/neuron-usage.mjs
// on why that is tracked, not assumed away). Never called for a failed candidate (never
// billed, nothing to record) or for "stub"/"anthropic" (neurons are a Cloudflare-only concept —
// Anthropic's own token usage is a real, separate cost, ~$0.30/mo at this volume per the module
// header above, tracked nowhere near this budget on purpose). The caller (ci/generate-posts.mjs,
// ci/company-descriptor.mjs) is the one that knows whether a given call is the WRITER or the
// DESCRIPTOR — this module has no opinion on that, same as it has none about hooks or scenes.
//
// (Neuron accounting) EXHAUSTION. A 429 whose body carries Cloudflare's documented code 4006
// ("daily free allocation of 10,000 neurons used up") means every other call this run will fail
// identically — see ci/cf-budget.mjs for the shared flag and the reasoning. `batch` below checks
// it BEFORE firing a fresh round of calls (no point making five doomed requests at once) and,
// on a rejection, distinguishes "the account is exhausted" (logged ONCE, globally, by
// `markExhausted`) from any other genuine per-candidate failure (still logged per-candidate,
// exactly as before) — this is the fix for the "five identical candidate failed: cloudflare
// 429" lines the brief calls out: they were never actually five DIFFERENT failures, they were
// one real cause reported five times with the real code never even read off the response body.

import { isExhausted, isExhaustionError, markExhausted } from "./cf-budget.mjs";

const CF_URL = (acct, model) => `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`;

/** Fire n independent calls. One failure must not lose the other four, so failures are
 *  logged and dropped rather than thrown — the caller decides whether what came back is
 *  enough to publish. Skips the round entirely (returns `[]` with no network call at all) once
 *  `isExhausted()` is already known true — see the module header. */
async function batch(n, one) {
  if (isExhausted()) return [];
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => one(i)));
  const out = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
    else if (r.status === "rejected") {
      if (isExhaustionError(r.reason)) markExhausted(); // idempotent — see ci/cf-budget.mjs
      else console.error(`  candidate failed: ${r.reason?.message ?? r.reason}`);
    }
  }
  return out;
}

/** Read a non-ok Cloudflare response's real error body and attach its documented error code
 *  (`errors[0].code`) to the thrown Error as `.cfCode`, so ci/cf-budget.mjs's
 *  `isExhaustionError` can tell code 4006 apart from every other reason a call can fail — a
 *  malformed/non-JSON error body (rare, but not assumed away) just leaves `cfCode` unset,
 *  exactly like any other non-4006 failure. */
async function cloudflareError(res) {
  let cfCode = null;
  try {
    const body = await res.json();
    cfCode = body?.errors?.[0]?.code ?? null;
  } catch {
    // Body wasn't JSON, or was already consumed — no code to extract, fall through.
  }
  const err = new Error(`cloudflare ${res.status}`);
  err.cfCode = cfCode;
  return err;
}

export function makeProvider(env = process.env, fetchImpl = globalThis.fetch) {
  const name = env.POST_PROVIDER || "cloudflare";

  if (name === "stub") {
    return async ({ n = 1 }) =>
      Array.from({ length: n }, (_, i) => `stub candidate ${i + 1}: TICK target $210 — 42% upside.`);
  }

  if (name === "cloudflare") {
    const acct = env.CF_ACCOUNT_ID;
    const token = env.CF_API_TOKEN;
    if (!acct) throw new Error("POST_PROVIDER=cloudflare needs CF_ACCOUNT_ID");
    if (!token) throw new Error("POST_PROVIDER=cloudflare needs CF_API_TOKEN");
    const model = env.CF_MODEL || "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

    return async ({ system, prompt, n = 1, onUsage }) =>
      batch(n, async () => {
        const res = await fetchImpl(CF_URL(acct, model), {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
            // High temperature on purpose: five near-identical candidates defeat best-of-N.
            temperature: 0.95,
            max_tokens: 300,
          }),
        });
        if (!res.ok) throw await cloudflareError(res);
        const j = await res.json();
        // (Neuron accounting) `result.usage` is Cloudflare's own documented field for this
        // model (`{ prompt_tokens, completion_tokens, total_tokens }` — verified against the
        // real published response schema, see ci/neuron-usage.mjs) — passed through exactly as
        // received, `undefined` and all, never guessed at.
        onUsage?.(j?.result?.usage);
        return (j?.result?.response ?? "").trim();
      });
  }

  if (name === "anthropic") {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("POST_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    const model = env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001";

    return async ({ system, prompt, n = 1 }) =>
      batch(n, async () => {
        const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model, max_tokens: 300, temperature: 1, system,
            messages: [{ role: "user", content: prompt }],
          }),
        });
        if (!res.ok) throw new Error(`anthropic ${res.status}`);
        const j = await res.json();
        return (j?.content?.[0]?.text ?? "").trim();
      });
  }

  throw new Error(`unknown provider "${name}" — expected cloudflare, anthropic or stub`);
}
