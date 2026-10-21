// "Track this stock" → start .github/workflows/track-requests.yml right away.
// No auth by design: the app only shows the button to signed-in users, and the lite run
// acts only on pending RTDB requests (which need sign-in to write), so a stray POST costs
// one ~30s no-op run. GH_TOKEN: fine-grained PAT, this repo only, Actions: read & write.
const DISPATCH =
  "https://api.github.com/repos/nitzan-massad/MarketPulse/actions/workflows/track-requests.yml/dispatches";

export default {
  async fetch(req, env) {
    const cors = {
      "access-control-allow-origin": env.ORIGIN,
      "access-control-allow-methods": "POST",
    };
    if (req.method === "OPTIONS") return new Response(null, { headers: cors });
    if (req.method !== "POST") return new Response("POST only", { status: 405, headers: cors });
    const r = await fetch(DISPATCH, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.GH_TOKEN}`,
        accept: "application/vnd.github+json",
        "user-agent": "marketpulse-track",
      },
      body: JSON.stringify({ ref: "main" }),
    });
    return new Response(null, { status: r.ok ? 204 : 502, headers: cors });
  },
};
