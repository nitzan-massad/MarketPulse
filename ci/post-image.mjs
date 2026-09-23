// THE PICTURE, FOR REAL — Cloudflare Workers AI Flux Schnell, sector (+ a deterministic
// gender seed) only.
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
// and a SEED only — never a hook fact, number, ticker-as-text or company name. Flux is well
// known for rendering text accurately, and the flux-1-schnell schema exposes no
// `negative_prompt` to suppress it. A number or name that reached the prompt would be a
// plausible route to a fabricated figure — a wrong price, a wrong date, a misspelled ticker —
// baked as pixels into a picture that sits next to a real public company's name. The seed
// (the post's ticker, passed by ci/generate-posts.mjs) is used for exactly one thing — see
// `personPhrase` below — and is never concatenated into the prompt AS TEXT, only hashed into a
// coin flip. The sector and that coin flip are the only things this module ever bases the
// prompt on.
//
// PEOPLE, NOW REQUIRED. The prompt used to end "no people, no faces, no hands, no
// silhouettes" — deliberately, because there was nothing for a person to be doing that
// wouldn't risk looking like it was illustrating a specific (unverified) claim. That's
// inverted now: every image shows one or more people doing the company's actual work — a
// scientist at a lab bench, an engineer on an offshore platform, a technician in a fab. The
// no-text/no-numbers/no-logos/no-watermark clauses stay, and matter MORE now, not less — real
// text is being burned onto this image next (ci/post-compose.mjs), and a photo that already
// contains stray rendered text or a logo would corrupt that.

/** One concrete WORKER + scene per sector TipRanks/Finviz actually emits (`src/data/
 *  stocks.json`'s `sec` values) — the person doing that industry's actual work, not a person
 *  incidentally standing in front of it. `General` is TipRanks' own unclassified bucket, not
 *  an industry, so its phrase is deliberately as generic as the fallback below (see
 *  postArt.ts's identical honesty about `General` -> the fallback scene). Add a scene here and
 *  the mapping is done — no seed, no draw function. */
const SECTOR_ROLE = {
  Healthcare: { role: "scientist", action: "at a lab bench in a bright, clean medical laboratory, examining glassware under soft natural light" },
  Technology: { role: "engineer", action: "working at a sleek wall of glowing display panels in a bright minimalist studio" },
  General: { role: "professional", action: "standing amid a soft arrangement of overlapping translucent geometric shapes in a bright studio" },
  Industrials: { role: "dockworker", action: "inspecting neatly stacked cargo containers in a sunlit shipping yard" },
  ConsumerCyclical: { role: "retail associate", action: "arranging merchandise on a bright boutique retail shelf" },
  Financial: { role: "banker", action: "standing in a grand marble bank hall with tall arched windows and soft daylight" },
  Energy: { role: "engineer", action: "inspecting solar panels across sweeping sandstone desert dunes under a bright, open sky" },
  CommunicationServices: { role: "broadcast technician", action: "working in a bright broadcast studio with a wall of softly glowing screens" },
  BasicMaterials: { role: "geologist", action: "examining layered mineral rock strata in warm earth tones under soft light" },
  ConsumerDefensive: { role: "grocery worker", action: "stocking a bright, tidy grocery aisle with neatly arranged packaged goods" },
  Utilities: { role: "technician", action: "inspecting a row of clean white power transmission towers against a pale sky" },
  RealEstate: { role: "architect", action: "standing before a bright modern glass office facade under a clear sky" },
};

/** Honest fallback for a sector this run has never seen — same posture as postArt.ts's
 *  `market` scene and the old FALLBACK_PHRASE: generic rather than wrong. */
const FALLBACK_ROLE = { role: "professional", action: "standing in a soft, abstract arrangement of translucent geometric shapes" };

/** FNV-1a over the seed, normalised to [0, 1). Same algorithm family as postArt.ts's
 *  `seeded()` (ticker -> deterministic look), reimplemented locally rather than imported: this
 *  module is plain ci/ ESM with no dependency on src/, and the two seeds serve unrelated
 *  purposes (a canvas draw's random walk vs. one coin flip here) — there is nothing to share
 *  beyond the hashing idea itself. Deterministic: the same ticker always yields the same
 *  fraction, which is the whole point — a given post's image looks the same every time it is
 *  regenerated, and never differs from run to run "by chance". */
function seedFraction(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967296;
}

/** ~90% "a woman", ~10% "a man" — the user's explicit direction, implemented deterministically
 *  off the post's ticker rather than by chance, so a given post always renders the same
 *  person. This is the ONLY thing `seed` (the ticker) is ever used for, and the two words this
 *  returns never carry any information about the ticker itself. */
export function personPhrase(seed) {
  return seedFraction(seed) < 0.1 ? "a man" : "a woman";
}

export function scenePhrase(sector, seed) {
  const key = String(sector ?? "").trim();
  const { role, action } = SECTOR_ROLE[key] ?? FALLBACK_ROLE;
  return `${personPhrase(seed)} ${role} ${action}`;
}

/** Two-to-three word industry descriptor, rendered beneath the company name at half its font
 *  size (ci/post-compose.mjs) — e.g. "Conocophillips" then "energy exploration". Same 12
 *  camelCase sectors SECTOR_ROLE maps, deliberately a SEPARATE small map rather than derived
 *  from the role/action prose above: the descriptor is a caption, not a scene, and the two
 *  should be free to read well independently. */
const SECTOR_DESCRIPTOR = {
  Healthcare: "medical research",
  Technology: "technology systems",
  General: "public markets",
  Industrials: "industrial manufacturing",
  ConsumerCyclical: "consumer retail",
  Financial: "financial services",
  Energy: "energy exploration",
  CommunicationServices: "broadcast media",
  BasicMaterials: "raw materials",
  ConsumerDefensive: "consumer staples",
  Utilities: "utility infrastructure",
  RealEstate: "real estate",
};

const DESCRIPTOR_FALLBACK = "financial markets";

export function descriptorFor(sector) {
  const key = String(sector ?? "").trim();
  return SECTOR_DESCRIPTOR[key] ?? DESCRIPTOR_FALLBACK;
}

/** The fixed template. Every clause after the scene exists to suppress a specific way Flux
 *  would otherwise contradict or embarrass the real data sitting on top of the card — numbers,
 *  tickers, logos — or interfere with the text ci/post-compose.mjs is about to burn onto this
 *  photo. Nothing here is per-post except `scenePhrase()`'s scene + person, and it never sees
 *  anything but the sector string and the seed fraction described above. */
export function buildImagePrompt(sector, seed) {
  const scene = scenePhrase(sector, seed);
  return (
    `Editorial stock photograph of ${scene}. Bright, airy, high-key lighting on a light ` +
    `background; soft natural light, clean minimalist composition, shallow depth of field, ` +
    `muted modern color palette. Ample negative space near the top and bottom of the frame for ` +
    `text to be added later. No text, no numbers, no digits, no charts, no graphs, no diagrams, ` +
    `no logos, no brand marks, no watermarks, no signage.`
  );
}

const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const FLUX_STEPS = 4; // ~43 neurons/image at this step count — see ci/README.md

/** Fire the Flux call for one sector and return the decoded JPEG bytes, or `null` on ANY
 *  failure — missing credentials, a non-2xx response, a malformed/unexpected body, a thrown
 *  network error. This must never throw: a failed image has to degrade to the canvas fallback
 *  in ci/generate-posts.mjs, never lose the post, so every failure path returns `null` instead
 *  of propagating. `fetchImpl` is injectable the same way ci/provider.mjs takes one, so
 *  ci/test-post-image.mjs never touches the network.
 *
 *  `ticker` is optional and, if given, seeds ONLY `personPhrase` (see above) — it is never
 *  written into the request body as text. Omitting it just means the image always renders the
 *  90%-likely "a woman" branch (`seedFraction(undefined)` is still deterministic). */
export async function generateImage({ sector, ticker, env = process.env, fetchImpl = globalThis.fetch }) {
  try {
    const acct = env.CF_ACCOUNT_ID;
    const token = env.CF_API_TOKEN;
    if (!acct || !token) return null;

    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${FLUX_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: buildImagePrompt(sector, ticker), steps: FLUX_STEPS }),
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
 *  out of sync on.
 *
 *  `.png`, not `.jpg`: the file this names is no longer the raw Flux photo, it is
 *  ci/post-compose.mjs's fused output (the photo + the burned-in text), which resvg rasterises
 *  to PNG. */
export function postImageFilename(id) {
  return `${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}.png`;
}
