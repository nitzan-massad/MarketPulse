// WHO WRITES THE COPY — one switch, so swapping models is an env var, not a refactor.
//
// Default is Cloudflare Workers AI because it is free: 10,000 neurons/day, and this
// pipeline burns roughly 15% of that at one post per 5h with five candidates per run.
// "anthropic" is here as the quality escape hatch (~$0.30/mo at this volume) for an A/B.
// "stub" is what `npm test` uses — no network in checks, ever.
//
// ponytail: a plain switch, not a class hierarchy. Three providers, one function each.

const CF_URL = (acct, model) => `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${model}`;

/** Fire n independent calls. One failure must not lose the other four, so failures are
 *  logged and dropped rather than thrown — the caller decides whether what came back is
 *  enough to publish. */
async function batch(n, one) {
  const settled = await Promise.allSettled(Array.from({ length: n }, (_, i) => one(i)));
  const out = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value) out.push(r.value);
    else if (r.status === "rejected") console.error(`  candidate failed: ${r.reason?.message ?? r.reason}`);
  }
  return out;
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
    const model = env.CF_MODEL || "@cf/meta/llama-3.1-8b-instruct";

    return async ({ system, prompt, n = 1 }) =>
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
        if (!res.ok) throw new Error(`cloudflare ${res.status}`);
        const j = await res.json();
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
