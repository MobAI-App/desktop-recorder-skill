#!/usr/bin/env node
/**
 * Generate upload copy (title / short post / Shorts title / thumbnail text)
 * from a demo timeline + the original prompt.
 *
 * Usage:
 *   node generate_copy.js <timeline.json> <prompt.txt> <copy.md>
 *
 * Strategy (deterministic, no LLM call here — the agent invoking this skill
 * can rewrite the output if it wants more polish):
 *
 *   - Title:        the strongest caption (longest non-empty caption) or
 *                   the first intent if no captions present.
 *   - Short post:   2–3 sentences built from intents in order; first
 *                   sentence describes the flow, second sentence is the
 *                   first caption verbatim.
 *   - Shorts title: the first caption, truncated to 40 chars.
 *   - Thumbnail:    the first caption, truncated to 5 words.
 *
 * The output uses the assets/templates/copy-template.md layout.
 */

const fs = require("fs");
const path = require("path");

if (process.argv.length < 5) {
  console.error("usage: node generate_copy.js <timeline.json> <prompt.txt> <copy.md>");
  process.exit(2);
}

const [, , TIMELINE, PROMPT, OUT] = process.argv;

const events = JSON.parse(fs.readFileSync(TIMELINE, "utf8"));
const prompt = fs.existsSync(PROMPT) ? fs.readFileSync(PROMPT, "utf8").trim() : "";

const captions = events.map((e) => e.caption).filter(Boolean);
const intents  = events.map((e) => e.intent).filter(Boolean);

function truncWords(s, n) {
  return s.split(/\s+/).slice(0, n).join(" ");
}
function truncChars(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + "…";
}

const strongest = captions
  .slice()
  .sort((a, b) => b.length - a.length)[0];

const title         = strongest || intents[0] || "Demo";
const firstCaption  = captions[0] || intents[0] || "Watch the demo";
const shortsTitle   = truncChars(firstCaption, 40);
const thumbnailText = truncWords(firstCaption, 5);

const flowSentence = intents.length > 0
  ? `Quick walk-through: ${intents.slice(0, 4).join(", ")}.`
  : `Quick demo of the flow.`;

const shortPost = [
  flowSentence,
  firstCaption.endsWith(".") ? firstCaption : firstCaption + ".",
  prompt ? `Context: ${truncWords(prompt, 25)}.` : "",
].filter(Boolean).join("\n\n");

const out = `# Title

${title}

# Short post

${shortPost}

# YouTube Shorts title

${shortsTitle}

# Thumbnail text

${thumbnailText}
`;

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out);

console.log(`Copy → ${OUT}`);
