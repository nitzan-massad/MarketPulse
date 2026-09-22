// THE PICTURE, FOR REAL — Cloudflare Workers AI Flux Schnell, sector only.
//
// src/postArt.ts draws the fallback: cheap, deterministic, and safe by construction because
// it carries no text at all. But it is procedural canvas, and canvas cannot be both genuinely
// light (the card is light now) and visually substantial — two of the seven scenes measured a
// mean brightness of 240 with a visual variation of 12 on 0-255, i.e. a blank white rectangle.
// So: one real image per post, from @cf/black-forest-labs/flux-1-schnell (Apache-2.0, ~43
// neurons/image at 4 steps, against the same free 10,000/day pool the text candidates already
// spend ~15% of). Canvas stays wired in ci/generate-posts.mjs as the fallback for any failure.
//
// CRITICAL, read before touching buildImagePrompt: the prompt below is built from the SECTOR
// ONLY — never a hook fact, number, ticker or company name. Flux is well known for rendering
// text accurately, and the flux-1-schnell schema exposes no `negative_prompt` to suppress it.
// A number or name that reached the prompt would be a plausible route to a fabricated figure —
// a wrong price, a wrong date, a misspelled ticker — baked as pixels into a picture that sits
// next to a real public company's name. The sector is the only fact this module ever sees.

/** One concrete scene per sector TipRanks/Finviz actually emits (`src/data/stocks.json`'s
 *  `sec` values), in the same "one entry, no cleverness" spirit as postArt.ts's SECTOR_SCENE —
 *  except these are prose for an image model, not a canvas draw function to pick. `General` is
 *  TipRanks' own unclassified bucket, not an industry, so its phrase is deliberately as generic
 *  as the fallback below (see postArt.ts's identical honesty about `General` -> the fallback
 *  scene). Add a scene here and the mapping is done — no seed, no draw function. */
export const SECTOR_PHRASE = {
  Healthcare: "a bright, clean medical laboratory with glassware and soft natural light",
  Technology: "a sleek wall of glowing display panels in a bright minimalist studio",
  General: "a soft arrangement of overlapping translucent geometric shapes in a bright studio",
  Industrials: "a sunlit shipping yard with neatly stacked cargo containers",
  ConsumerCyclical: "a bright boutique retail shelf with neatly arranged merchandise",
  Financial: "a grand marble bank hall with tall arched windows and soft daylight",
  Energy: "sweeping sandstone desert dunes under a bright, open sky",
  CommunicationServices: "a bright broadcast studio with a wall of softly glowing screens",
  BasicMaterials: "layered mineral rock strata in warm earth tones under soft light",
  ConsumerDefensive: "a bright, tidy grocery aisle with neatly stacked packaged goods",
  Utilities: "a row of clean white power transmission towers against a pale sky",
  RealEstate: "a bright modern glass office facade under a clear sky",
};

/** Honest fallback for a sector this run has never seen — same posture as postArt.ts's
 *  `market` scene: generic rather than wrong. */
const FALLBACK_PHRASE = "a soft, abstract arrangement of translucent geometric shapes";

export function scenePhrase(sector) {
  const key = String(sector ?? "").trim();
  return SECTOR_PHRASE[key] ?? FALLBACK_PHRASE;
}

/** The fixed template. Every clause after the scene exists to suppress a specific way Flux
 *  would otherwise contradict or embarrass the real data sitting on top of the card in the
 *  overlay — numbers, tickers, logos, faces. Nothing here is per-post; only `scenePhrase()`
 *  varies, and it never sees anything but the sector string. */
export function buildImagePrompt(sector) {
  const scene = scenePhrase(sector);
  return (
    `Editorial stock photograph of ${scene}. Bright, airy, high-key lighting on a light ` +
    `background; soft natural light, clean minimalist composition, shallow depth of field, ` +
    `muted modern color palette. Abstract and conceptual, ample negative space. No text, no ` +
    `numbers, no digits, no charts, no graphs, no diagrams, no logos, no brand marks, no ` +
    `watermarks, no signage, no people, no faces, no hands, no silhouettes.`
  );
}

const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const FLUX_STEPS = 4; // ~43 neurons/image at this step count — see ci/README.md

/** Fire the Flux call for one sector and return the decoded JPEG bytes, or `null` on ANY
 *  failure — missing credentials, a non-2xx response, a malformed/unexpected body, a thrown
 *  network error. This must never throw: a failed image has to degrade to the canvas fallback
 *  in ci/generate-posts.mjs, never lose the post, so every failure path returns `null` instead
 *  of propagating. `fetchImpl` is injectable the same way ci/provider.mjs takes one, so
 *  ci/test-post-image.mjs never touches the network. */
export async function generateImage({ sector, env = process.env, fetchImpl = globalThis.fetch }) {
  try {
    const acct = env.CF_ACCOUNT_ID;
    const token = env.CF_API_TOKEN;
    if (!acct || !token) return null;

    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${FLUX_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: buildImagePrompt(sector), steps: FLUX_STEPS }),
      },
    );
    if (!res.ok) return null;

    const body = await res.json();
    const b64 = body?.result?.image;
    if (typeof b64 !== "string" || !b64) return null;

    return Buffer.from(b64, "base64");
  } catch (err) {
    console.error(`  image generation failed — ${err?.message ?? err}`);
    return null;
  }
}

/** Post ids are `${ticker}-${isoTimestamp}`, e.g. "ALAB-2026-09-22T14:35:30.122Z" — the ISO
 *  stamp's `:` and `.` are not filesystem/URL-safe, so every character outside
 *  `[a-zA-Z0-9_-]` collapses to `-`. This is the ONLY place that computes the mapping:
 *  ci/generate-posts.mjs calls it once, at write time, and stores the result verbatim on the
 *  post record as `image`. The frontend (src/components/PostFeed.tsx) just reads that field —
 *  it never re-derives a filename from an id, so there is nothing for the two sides to drift
 *  out of sync on. */
export function postImageFilename(id) {
  return `${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}.jpg`;
}
