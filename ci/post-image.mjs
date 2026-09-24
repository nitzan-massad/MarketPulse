// THE PICTURE, FOR REAL — Cloudflare Workers AI Flux Schnell, ALWAYS, for every post. Scene
// comes from the SAME per-company model call ci/company-descriptor.mjs already makes (the
// identity-line descriptor), extended to also return a scene; the sector-role map below is
// only the deterministic FALLBACK for when that call fails.
//
// src/postArt.ts draws a canvas fallback: cheap, deterministic, and safe by construction
// because it carries no text at all. But it is procedural canvas, and canvas cannot be both
// genuinely light (the card is light now) and visually substantial — two of the seven scenes
// measured a mean brightness of 240 with a visual variation of 12 on 0-255, i.e. a blank white
// rectangle. So: one real Flux image per post, from @cf/black-forest-labs/flux-1-schnell
// (Apache-2.0, ~43 neurons/image at 4 steps, against the same free 10,000/day pool the text
// candidates already spend ~15% of). Canvas stays wired in ci/generate-posts.mjs as the
// fallback for any failure — never the abstract mark this module used to render for `General`
// (removed, see below).
//
// CRITICAL, read before touching buildImagePrompt: the prompt below is built from the SECTOR,
// a SEED, and now an optional per-company SCENE string — never a hook fact, number,
// ticker-as-text or company name. Flux is well known for rendering text accurately, and the
// flux-1-schnell schema exposes no `negative_prompt` to suppress it. A number or name that
// reached the prompt would be a plausible route to a fabricated figure — a wrong price, a wrong
// date, a misspelled ticker — baked as pixels into a picture that sits next to a real public
// company's name. The scene string is validated upstream by ci/company-descriptor.mjs's
// `sanitizeScene` (no digits, no $/%, no ticker, no logos/brand/chart words) before it ever
// reaches this module, on the same posture as the descriptor's own `sanitizeDescriptor`. The
// seed (the post's ticker, passed by ci/generate-posts.mjs) is used for exactly one thing — see
// `personPhrase` below — and is never concatenated into the prompt AS TEXT, only hashed into a
// coin flip.
//
// PEOPLE, NOW REQUIRED. The prompt used to end "no people, no faces, no hands, no
// silhouettes" — deliberately, because there was nothing for a person to be doing that
// wouldn't risk looking like it was illustrating a specific (unverified) claim. That's
// inverted now: every image shows one or more people doing the company's actual work — a
// scientist at a lab bench, an engineer on an offshore platform, a technician in a fab. The
// no-text/no-numbers/no-logos/no-watermark clauses stay, and matter MORE now, not less — real
// text is being burned onto this image next (ci/post-compose.mjs), and a photo that already
// contains stray rendered text or a logo would corrupt that.
//
// EVERY POST GETS A PHOTO, INCLUDING `General`. This used to skip Flux entirely for TipRanks'
// unclassified catch-all sector (~44 of 455 rows, including Alphabet) and render a
// palette-driven abstract mark instead — the reasoning was that an unclassified bucket gives
// nothing concrete to depict. The user rejected that outright: an abstract mark for a real,
// named company (Alphabet chief among them) is exactly the bland, generic imagery this whole
// effort has been moving away from. The fix is NOT a generic "person in an office" scene for
// `General` either — it is the same fix already shipped for the text descriptor
// (`descriptorFor` below is now a fallback, not the primary path; see
// ci/company-descriptor.mjs): ask the model for a scene specific to what the company actually
// DOES, informed by its real business description, sector be damned. `SECTOR_ROLE` below
// therefore now serves only as the deterministic fallback scene for when that model call fails
// or a company's scene fails validation — never the primary source for any sector, `General`
// included. On the user's own logo suggestion (a Google logo on the building) — deliberately
// NOT done: Flux renders brand marks as garbled pseudo-text, and a fabricated logo on a real,
// named, public company is a misrepresentation in a way an anonymous glass campus is not. The
// setting itself (a data-centre hall, a corporate campus, a lab) carries the recognisability
// instead, and the no-logo/no-brand-marks clause in `buildImagePrompt` stays untouched.

/** DETERMINISTIC FALLBACK ONLY, one concrete WORKER + scene per sector TipRanks/Finviz actually
 *  emits (`src/data/stocks.json`'s `sec` values) — used when the per-company model call
 *  (ci/company-descriptor.mjs's `describeCompany`) fails or its scene fails validation. The
 *  PRIMARY scene for every company, `General` included, is now the model-written one — see the
 *  module header. `General`'s entry here is deliberately as generic as the fallback below (it
 *  is TipRanks' own unclassified bucket, not an industry, and this map is never asked to be
 *  more than an honest last resort). Add a scene here and the fallback mapping is done — no
 *  seed, no draw function.
 *
 *  CLOSE, LARGE, MID-ACTION (Task: "images need to be more interesting, people much more
 *  prominent"). The old scenes put the person mid-distance in a mostly-empty room — safe, but
 *  small and static. Every action below is written so the person's hands and the work itself
 *  fill most of the frame, caught doing something rather than posed for a portrait. Never a
 *  pronoun ("her"/"his") in these strings — `scenePhrase` prepends the gender choice
 *  separately, so the action text has to read correctly after EITHER "a woman ROLE" or "a man
 *  ROLE" (the model-written scene follows the identical rule — see
 *  ci/company-descriptor.mjs's `buildDescriptorPrompt`). Screens/monitors/price-boards are
 *  deliberately avoided (Technology and CommunicationServices used to feature a "wall of
 *  glowing display panels"/"screens" — exactly the kind of prop Flux has been seen inventing
 *  chart-like numeric marks onto, see buildImagePrompt below): a scene with no natural reason to
 *  contain signage is less likely to produce it, since the no-numbers instruction cannot be
 *  enforced (no negative_prompt on this model). */
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

/** The deterministic sector-mapped ROLE + ACTION text alone, with no person prefix — this is
 *  what `buildImagePrompt` falls back to when no (or no valid) model-written scene is supplied.
 *  Split out from `scenePhrase` below so `buildImagePrompt` can prepend `personPhrase` to
 *  EITHER this fallback OR a model-written scene through the identical code path. */
export function sectorScenePhrase(sector) {
  const key = String(sector ?? "").trim();
  const { role, action } = SECTOR_ROLE[key] ?? FALLBACK_ROLE;
  return `${role} ${action}`;
}

/** `personPhrase` + the deterministic sector fallback scene, unchanged in shape from before this
 *  module gained a per-company model-written scene — still used directly by
 *  ci/test-post-image.mjs's sector-coverage assertions, and by `buildImagePrompt` whenever no
 *  custom scene is supplied. */
export function scenePhrase(sector, seed) {
  return `${personPhrase(seed)} ${sectorScenePhrase(sector)}`;
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
 *  photo. Nothing here is per-post except the scene + person, and the scene is either a
 *  per-company model-written phrase (`customScene`, validated upstream by
 *  ci/company-descriptor.mjs's `sanitizeScene`) or, absent/failed, the deterministic sector
 *  fallback (`sectorScenePhrase`).
 *
 *  TIGHT CROPS. The best image produced under the old wording (a scientist mid-pipette) was
 *  already an extreme close-up with hands doing real work filling the frame; the weakest was
 *  mid-distance and static. "Close or medium-close" left Flux room to pick the weaker option —
 *  "extreme close-up" plus an explicit "face and hands both in frame" removes that choice.
 *
 *  SCREENS, REDIRECTED, NOT JUST FORBIDDEN. Flux exposes no `negative_prompt` on this model, and
 *  a purely negative instruction ("no charts, no graphs, no diagrams") has already been ignored
 *  once — a generated screen wall rendered chart-like numeric marks despite it (see the
 *  SECTOR_ROLE comment above, which is why Technology/CommunicationServices no longer route
 *  through screens at all). Telling a model what NOT to draw still requires it to imagine the
 *  forbidden thing first; telling it what a screen looks like INSTEAD (soft, out-of-focus colour
 *  and bokeh) gives it a positive target to paint even if a monitor sneaks into frame
 *  incidentally (a background office display, a phone on a desk) despite no scene calling for
 *  one.
 *
 *  CASTING DIRECTION IS NEUTRAL, ON PURPOSE. A prior pass added "the subject is strikingly
 *  attractive, cast and styled the way a commercial stock-photography shoot casts and grooms
 *  its models — well-groomed, polished, professionally lit for a magazine or advertising
 *  campaign" per the user's own direction at the time. The user has since explicitly retracted
 *  that direction, and it is removed here — reverted precisely, not softened: no appearance
 *  instruction beyond what the photographic style itself already implies (bright, brightly but naturally lit,
 *  editorial). Everything else from that same pass survives unchanged: the deterministic
 *  ~90%/10% woman/man split (`personPhrase`), the extreme-close-up/tight-crop framing, the
 *  medium-key lighting aesthetic, the bokeh-not-legible-marks screen instruction, and every
 *  no-text/no-numbers/no-logos/no-watermark clause below. */
export function buildImagePrompt(sector, seed, customScene) {
  const roleAction = typeof customScene === "string" && customScene.trim()
    ? customScene.trim()
    : sectorScenePhrase(sector);
  const scene = `${personPhrase(seed)} ${roleAction}`;
  return (
    `Editorial stock photograph, extreme close-up shot, of ${scene}. Face and hands are both ` +
    `in frame, the person and their work filling most of the frame, caught candidly mid-action, ` +
    `not posed for the camera, shallow depth of field. Bright, evenly lit and clearly visible, ` +
    `with soft daylight and gentle, natural shadows — light and open, but never washed out or ` +
    `blown out; keep real tonal depth and rich, true-to-life colour. If any screen, monitor, ` +
    `or display happens to appear anywhere in the frame, it shows only soft, out-of-focus ` +
    `coloured light and bokeh — never legible marks of any kind. Even while the person fills ` +
    `most of the frame, keep the extreme top and bottom edges relatively simple so bold text ` +
    `can be overlaid directly on the photo later. No text, no numbers, no digits, no logos, no ` +
    `brand marks, no watermarks, no signage.`
  );
}

const FLUX_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const FLUX_STEPS = 4; // ~43 neurons/image at this step count — see ci/README.md

/** Fire the Flux call for one post and return the decoded JPEG bytes, or `null` on ANY
 *  failure — missing credentials, a non-2xx response, a malformed/unexpected body, a thrown
 *  network error. This must never throw: a failed image has to degrade to the canvas fallback
 *  in ci/generate-posts.mjs, never lose the post, so every failure path returns `null` instead
 *  of propagating. `fetchImpl` is injectable the same way ci/provider.mjs takes one, so
 *  ci/test-post-image.mjs never touches the network.
 *
 *  `ticker` is optional and, if given, seeds ONLY `personPhrase` (see above) — it is never
 *  written into the request body as text. Omitting it just means the image always renders the
 *  90%-likely "a woman" branch (`seedFraction(undefined)` is still deterministic).
 *
 *  EVERY sector, including `General`, reaches Flux — there is no more skip. `scene`, if given,
 *  is the per-company model-written phrase from ci/company-descriptor.mjs (already validated by
 *  its `sanitizeScene`); omitted or falsy, `buildImagePrompt` falls back to the deterministic
 *  `sectorScenePhrase(sector)`. Either way this call never returns anything but a real Flux
 *  photo or `null` — no abstract-mark branch survives here (see the module header). */
export async function generateImage({ sector, ticker, scene, env = process.env, fetchImpl = globalThis.fetch }) {
  try {
    const acct = env.CF_ACCOUNT_ID;
    const token = env.CF_API_TOKEN;
    if (!acct || !token) return null;

    const res = await fetchImpl(
      `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/run/${FLUX_MODEL}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ prompt: buildImagePrompt(sector, ticker, scene), steps: FLUX_STEPS }),
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
