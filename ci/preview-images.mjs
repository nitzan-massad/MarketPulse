// Manual preview: renders a few Flux photos with the current buildImagePrompt into
// preview-images/ (uploaded as a workflow artifact). Touches no repo data.
// ponytail: fixed sample of 4, ~230 neurons; widen SAMPLES if a bigger look is needed.
import { mkdirSync, writeFileSync } from "node:fs";
import { buildImagePrompt, generateImage } from "./post-image.mjs";

const SAMPLES = [
  ["Technology", "AAPL"],   // woman
  ["Healthcare", "PFE"],    // woman
  ["Financial", "JPM"],     // woman
  ["ConsumerCyclical", "TSLA"], // man
];

mkdirSync("preview-images", { recursive: true });
let ok = 0;
for (const [sector, ticker] of SAMPLES) {
  const img = await generateImage({ sector, ticker });
  writeFileSync(`preview-images/${ticker}-${sector}.txt`, buildImagePrompt(sector, ticker));
  if (img) { writeFileSync(`preview-images/${ticker}-${sector}.jpg`, img); ok++; }
  console.log(`${ticker} ${sector}: ${img ? "ok" : "FAILED"}`);
}
if (!ok) process.exit(1);
