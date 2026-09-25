import { DIMENSIONS } from "./dimensions.js";
import type {
  DimensionSummary,
  EvaluatedMessage,
  EvidenceExcerpt,
  ParsedMessage,
  PerMessageScore,
  Profile,
} from "./types.js";

/** Maximum length of a stored evidence excerpt; mirrored in the schema. */
const EXCERPT_MAX = 140;

/** Minimum scored messages before a dimension's aggregate is treated as stable. */
const MIN_STABLE_SAMPLES = 3;

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Remove the most common direct identifiers before an excerpt is stored. */
function scrubExcerpt(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]")
    .replace(/\bhttps?:\/\/\S+/gi, "[link]")
    .replace(/@[\w.-]+/g, "@handle")
    .replace(/\s+/g, " ")
    .trim();
}

/** Truncate a scrubbed excerpt to the schema's length ceiling. */
export function excerptOf(text: string): string {
  const scrubbed = scrubExcerpt(text);
  return scrubbed.length <= EXCERPT_MAX ? scrubbed : `${scrubbed.slice(0, EXCERPT_MAX - 1)}…`;
}

/**
 * Pick short representative excerpts — the highest- and lowest-scoring messages
 * — as evidence for a dimension. Self-disclosure never stores an excerpt.
 */
function buildEvidence(
  dimensionId: string,
  perMessage: readonly PerMessageScore[],
  contentByIndex: ReadonlyMap<number, string>,
): EvidenceExcerpt[] {
  if (dimensionId === "self_disclosure" || perMessage.length === 0) return [];
  const ordered = [...perMessage].sort((a, b) => b.score - a.score);
  const picks = [ordered[0], ordered[ordered.length - 1]];
  const seen = new Set<number>();
  const evidence: EvidenceExcerpt[] = [];
  for (const pick of picks) {
    if (!pick || seen.has(pick.index)) continue;
    const content = contentByIndex.get(pick.index);
    if (!content) continue;
    seen.add(pick.index);
    evidence.push({ index: pick.index, excerpt: excerptOf(content) });
  }
  return evidence;
}

/**
 * Fold per-message scores into one profile: each dimension's value is the mean
 * normalized score across scored messages, with population standard deviation,
 * mean confidence, sample size, a stability flag, and representative evidence.
 *
 * @param evaluated - one entry per message in `messages`, null when that message failed.
 */
export function aggregate(
  source: string,
  author: string | null,
  messages: readonly ParsedMessage[],
  evaluated: readonly (EvaluatedMessage | null)[],
  usage: { input_tokens: number; output_tokens: number },
): Profile {
  const contentByIndex = new Map<number, string>();
  for (const message of messages) contentByIndex.set(message.index, message.content);

  const dimensions: DimensionSummary[] = DIMENSIONS.map((dimension) => {
    const perMessage: PerMessageScore[] = [];
    for (let i = 0; i < evaluated.length; i++) {
      const result = evaluated[i];
      const message = messages[i]!;
      if (!result || !(dimension.id in result.scores)) continue;
      perMessage.push({
        index: message.index,
        score: result.scores[dimension.id]!,
        confidence: result.confidence[dimension.id]!,
      });
    }

    const n = perMessage.length;
    let sum = 0;
    let confidenceSum = 0;
    for (const entry of perMessage) {
      sum += entry.score;
      confidenceSum += entry.confidence;
    }
    const mean = n === 0 ? 0 : sum / n;
    const variance = n === 0 ? 0 : perMessage.reduce((acc, entry) => acc + (entry.score - mean) ** 2, 0) / n;

    return {
      id: dimension.id,
      label: dimension.label,
      category: dimension.category,
      group: dimension.group,
      polarity: dimension.polarity,
      direction: dimension.direction,
      basis: dimension.basis,
      note: dimension.note,
      score: round3(mean),
      stddev: round3(Math.sqrt(variance)),
      confidence: round3(n === 0 ? 0 : confidenceSum / n),
      n,
      stable: n >= MIN_STABLE_SAMPLES,
      evidence: buildEvidence(dimension.id, perMessage, contentByIndex),
      messages: perMessage,
    };
  });

  return {
    source,
    author,
    messageCount: messages.length,
    scoredCount: evaluated.filter((entry) => entry !== null).length,
    generatedAt: new Date().toISOString(),
    dimensions,
    usage,
  };
}
