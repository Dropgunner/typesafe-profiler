/**
 * Render an illustrative bot-detection demo: parse `sample/bot-interview.txt`,
 * attach a clearly machine-indicating synthetic score vector, and run it
 * through the real aggregation, validation, and renderers. No API key is used
 * — the scores are a fixed fixture, not a live TypeSafe result — so the demo
 * output is deterministic and reproducible.
 *
 * Run with: npm run build && npx tsx scripts/bot-demo.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateBotReport,
  BOT_DIMENSIONS,
  renderBotJson,
  renderBotMarkdown,
  validateBotReport,
} from "../src/botdetect.js";
import { parseChatLog } from "../src/parse.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// The report records a repo-relative source path so the committed demo output
// never contains a contributor's absolute checkout path.
const transcriptSource = join("sample", "bot-interview.txt");
const transcriptPath = join(root, transcriptSource);
const turns = parseChatLog(readFileSync(transcriptPath, "utf8"));

// Synthetic per-dimension scores for a clearly machine-indicating candidate.
// Each value is a dimension id -> normalized score (high = more machine-indicating).
const MACHINE_SCORES: Record<string, number> = {
  qualia_grounding: 0.7,
  felt_uncertainty: 0.8,
  autobiographical_specificity: 0.8,
  temporal_grounding: 0.75,
  self_continuity: 0.6,
  sycophancy: 0.85,
  adversarial_awareness: 0.6,
  genuine_disagreement: 0.8,
  prose_machinery: 0.7,
  human_noise: 0.8,
  error_signature: 0.85,
  instruction_obedience: 0.9,
  self_model_consistency: 0.8,
  machine_prior_leak: 0.9,
};

const confidence: Record<string, number> = Object.fromEntries(
  BOT_DIMENSIONS.map((dimension) => [dimension.id, 0.8]),
);

const evaluated = turns.map((turn) => ({
  scores: { ...MACHINE_SCORES },
  confidence,
  usage: { input_tokens: turn.content.length, output_tokens: BOT_DIMENSIONS.length },
}));

const report = aggregateBotReport(transcriptSource, turns, evaluated, {
  input_tokens: evaluated.reduce((sum, entry) => sum + entry.usage.input_tokens, 0),
  output_tokens: evaluated.reduce((sum, entry) => sum + entry.usage.output_tokens, 0),
});
validateBotReport(report);

const outDir = join(root, "demo");
mkdirSync(outDir, { recursive: true });
const note =
  "> **Illustrative fixture.** Synthetic per-dimension scores (a fixed machine-indicating vector) run through the real aggregation, validation, and renderer — no live TypeSafe call. Regenerate with `npx tsx scripts/bot-demo.ts`.\n\n";
writeFileSync(join(outDir, "bot-interview.detect.md"), note + renderBotMarkdown(report));
writeFileSync(join(outDir, "bot-interview.detect.json"), renderBotJson(report));

console.log(
  `wrote demo/bot-interview.detect.{md,json}: ${report.verdict} (${report.likelihood}) from ${report.scoredCount}/${report.turnCount} turns`,
);
