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
 *  the mapping is done — no seed, no draw function.
 *
 *  CLOSE, LARGE, MID-ACTION (Task: "images need to be more interesting, people much more
 *  prominent"). The old scenes put the person mid-distance in a mostly-empty room — safe, but
 *  small and static. Every action below is written so the person's hands and the work itself
 *  fill most of the frame, caught doing something rather than posed for a portrait. Never a
 *  pronoun ("her"/"his") in these strings — `scenePhrase` prepends the gender choice
 *  separately, so the action text has to read correctly after EITHER "a woman ROLE" or "a man
 *  ROLE". Screens/monitors/price-boards are deliberately avoided (Technology and
 *  CommunicationServices used to feature a "wall of glowing display panels"/"screens" — exactly
 *  the kind of prop Flux has been seen inventing chart-like numeric marks onto, see
 *  buildImagePrompt below): a scene with no natural reason to contain signage is less likely to
 *  produce it, since the no-numbers instruction cannot be enforced (no negative_prompt on this
 *  model). */
const SECTOR_ROLE = {
  Healthcare: { role: "scientist", action: "leaning in close over a lab bench, gloved hands pipetting a sample into a rack of vials mid-motion, hands and work filling most of the frame in a bright, clean laboratory" },
  Technology: { role: "engineer", action: "soldering a circuit board at a bright workbench, hands and board close and filling most of the frame, caught mid-motion" },
  General: { role: "professional", action: "caught mid-motion arranging a cluster of translucent geometric shapes on a bright table, hands and shapes filling most of the frame" },
  Industrials: { role: "dockworker", action: "guiding a crane hook onto a shipping container by hand, close and mid-motion, filling most of the frame in a sunlit shipping yard" },
  ConsumerCyclical: { role: "retail associate", action: "steaming a garment on a mannequin mid-motion, hands and fabric close and filling most of the frame in a bright boutique" },
  Financial: { role: "banker", action: "mid-handshake across a marble-topped desk, the handshake filling most of the frame, the grand hall softly blurred behind" },
  Energy: { role: "engineer", action: "bolting a bracket onto a solar panel mid-motion, hands and panel close and filling most of the frame against sweeping desert dunes" },
  CommunicationServices: { role: "broadcast technician", action: "adjusting a microphone boom mid-motion, hands and boom close and filling most of the frame, the studio softly blurred behind" },
  BasicMaterials: { role: "geologist", action: "cracking open a mineral rock sample with a hammer mid-motion, hands and rock close and filling most of the frame in warm earth tones" },
  ConsumerDefensive: { role: "grocery worker", action: "stacking cans on a bright shelf mid-motion, hands and cans filling most of the frame" },
  Utilities: { role: "technician", action: "tightening a bolt on power equipment with a wrench mid-motion, gloved hands filling most of the frame against a pale sky" },
  RealEstate: { role: "architect", action: "unrolling a blueprint across a table mid-motion, hands and drawing close and filling most of the frame, a bright glass facade softly blurred behind" },
};

/** Honest fallback for a sector this run has never seen — same posture as postArt.ts's
 *  `market` scene and the old FALLBACK_PHRASE: generic rather than wrong, but still close and
 *  mid-action rather than a static portrait (see the SECTOR_ROLE comment above). */
const FALLBACK_ROLE = { role: "professional", action: "caught mid-motion arranging a cluster of translucent geometric shapes on a bright table, hands and shapes filling most of the frame" };

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

/** Two-to-four word industry descriptor, rendered beneath the company name at half its font
 *  size (ci/post-compose.mjs). This USED to be a category label ("technology systems" under
 *  Microsoft — flat, taxonomic, could describe a thousand companies). The brief: something
 *  characterful, the thing about the industry that makes you look twice, not a sector name
 *  restated — what a sharp editor would put there, not what a filing would. Same 12 camelCase
 *  sectors SECTOR_ROLE maps, deliberately a SEPARATE small map rather than derived from the
 *  role/action prose above: the descriptor is a caption, not a scene, and the two should be
 *  free to read well independently.
 *
 *  `General` deserved particular thought (per the brief): it is TipRanks' own unclassified
 *  bucket, not an industry, so "public markets" was actively the worst offender — it rendered
 *  under Alphabet, a company that is about as far from generic as this dataset gets. The fix
 *  isn't a punchier synonym for "unclassified", it's being honest about what usually lands in
 *  this bucket: names too large or too diversified for a single sector tag to hold (Alphabet
 *  is exactly that shape) — "too big to label" says that directly, and reads as a compliment
 *  ("this doesn't reduce to a category") rather than a placeholder. `DESCRIPTOR_FALLBACK` is
 *  the separate, rarer case of a sector string this map has never even heard of (not the same
 *  as `General`, which IS one of the 12 known keys) — same honesty, different wording so the
 *  two don't read as copies of each other if they ever appear side by side in the same run. */
const SECTOR_DESCRIPTOR = {
  Healthcare: "chasing the next cure",
  Technology: "building what's next",
  General: "too big to label",
  Industrials: "keeping the world moving",
  ConsumerCyclical: "chasing the next trend",
  Financial: "where the money moves",
  Energy: "powering the grid",
  CommunicationServices: "keeping everyone connected",
  BasicMaterials: "digging up the basics",
  ConsumerDefensive: "stocking the essentials",
  Utilities: "keeping the lights on",
  RealEstate: "building the skyline",
};

const DESCRIPTOR_FALLBACK = "flying under the radar";

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
    `Editorial stock photograph, close or medium-close shot, of ${scene}. The person and their ` +
    `work fill a large part of the frame, caught candidly mid-action, not posed for the camera. ` +
    `Bright, airy, high-key lighting on a light background; soft natural light, shallow depth of ` +
    `field, muted modern color palette. Even while the person fills most of the frame, keep the ` +
    `extreme top and bottom edges relatively simple so bold text can be overlaid directly on the ` +
    `photo later. No text, no numbers, no digits, no charts, no graphs, no diagrams, no logos, no ` +
    `brand marks, no watermarks, no signage.`
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
 *  `.jpg`, not `.png`: the file this names is ci/post-compose.mjs's fused output (the photo +
 *  the burned-in text), which it now encodes as a JPEG (ci/jpeg-encode.mjs) — a ~900KB PNG per
 *  post at POSTS_KEEP=200 was heading toward ~180MB committed to git for what is, pixel for
 *  pixel, a photograph. */
export function postImageFilename(id) {
  return `${String(id).replace(/[^a-zA-Z0-9_-]/g, "-")}.jpg`;
}
