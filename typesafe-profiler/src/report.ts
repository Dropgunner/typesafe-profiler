import { CATEGORIES } from "./dimensions.js";
import type { DimensionSummary, Profile } from "./types.js";

function fmt(value: number): string {
  return value.toFixed(2);
}

/** Short qualitative reading of a dimension's mean score, polarity-aware. */
function reading(dimension: DimensionSummary): string {
  const score = dimension.score;
  if (dimension.polarity === "inverted-risk") {
    if (score >= 0.6) return "elevated";
    if (score >= 0.4) return "moderate";
    return "low";
  }
  if (score >= 0.7) return "high";
  if (score >= 0.45) return "moderate";
  return "low";
}

/** True when a high score on this dimension is a concern (inverted-risk, elevated). */
function isElevatedRisk(dimension: DimensionSummary): boolean {
  return dimension.polarity === "inverted-risk" && dimension.score >= 0.6;
}

/** Space-prefixed annotations beyond the reading: no data, low sample, low confidence. */
function annotation(dimension: DimensionSummary): string {
  const parts: string[] = [];
  if (dimension.n === 0) parts.push("no data");
  if (dimension.n > 0 && !dimension.stable) parts.push("low sample");
  if (dimension.confidence > 0 && dimension.confidence < 0.5) parts.push("low confidence");
  return parts.length === 0 ? "" : ` ${parts.join(", ")}`;
}

/** Whether a dimension should appear in the "Flagged" section. */
function isFlagged(dimension: DimensionSummary): boolean {
  return isElevatedRisk(dimension) || annotation(dimension).trim() !== "";
}

function detailCell(dimension: DimensionSummary): string {
  const warning = isElevatedRisk(dimension) ? " ⚠" : "";
  return `${reading(dimension)}${warning}${annotation(dimension)}`;
}

function summaryTable(profile: Profile): string {
  const lines = [
    "| Category | Dimension | Score | n | Confidence | Polarity | Reading |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const category of CATEGORIES) {
    for (const dimension of profile.dimensions) {
      if (dimension.category !== category) continue;
      lines.push(
        `| ${category} | ${dimension.label} | ${fmt(dimension.score)} | ${dimension.n} | ${fmt(dimension.confidence)} | ${dimension.polarity} | ${reading(dimension)} |`,
      );
    }
  }
  return lines.join("\n");
}

function detailSections(profile: Profile): string {
  const sections: string[] = [];
  for (const category of CATEGORIES) {
    const dimensions = profile.dimensions.filter((dimension) => dimension.category === category);
    if (dimensions.length === 0) continue;
    sections.push(
      `### ${category}`,
      "",
      "| Dimension | Direction | Score | StdDev | n | Confidence | Reading |",
      "| --- | --- | --- | --- | --- | --- | --- |",
    );
    for (const dimension of dimensions) {
      sections.push(
        `| ${dimension.label} | ${dimension.direction} | ${fmt(dimension.score)} | ${fmt(dimension.stddev)} | ${dimension.n} | ${fmt(dimension.confidence)} | ${detailCell(dimension)} |`,
      );
    }
    sections.push("");
  }
  return sections.join("\n");
}

function evidenceSection(profile: Profile): string {
  const entries = profile.dimensions
    .filter((dimension) => dimension.evidence.length > 0)
    .map((dimension) => {
      const quotes = dimension.evidence.map((item) => `"${item.excerpt}"`).join(" · ");
      return `- **${dimension.label}**: ${quotes}`;
    });
  if (entries.length === 0) return "None (self-disclosure is never quoted, and unscored dimensions have no excerpts).";
  return entries.join("\n");
}

function flaggedSection(profile: Profile): string {
  const flagged = profile.dimensions.filter(isFlagged);
  if (flagged.length === 0) return "None.";
  return flagged
    .map((dimension) => {
      const risk = isElevatedRisk(dimension) ? " ⚠ elevated risk" : "";
      return `- **${dimension.label}** (${dimension.category}): score ${fmt(dimension.score)}, confidence ${fmt(dimension.confidence)}${risk}${annotation(dimension)}`;
    })
    .join("\n");
}

function caveats(profile: Profile): string {
  const noted = profile.dimensions.filter((dimension) => dimension.note);
  const lines = [
    "Scores are per-dimension means (0–1) of TypeSafe judgments over individual messages. A single message is weak evidence for trait-level dimensions, so interpret the aggregate as a rough, heuristic signal — not a clinical or psychological assessment.",
    "",
    "Every dimension records its direction (a high score means \"more of\" the named trait), its polarity (desirable / diagnostic / inverted-risk), what the score was inferred from (basis), and a confidence value. Inverted-risk dimensions are flagged when elevated; a low sample (fewer than three scored messages) is annotated.",
    "",
    "Each profile is validated against a fixed schema (dimension enum, 0–1 range, polarity and basis enums, required evidence) before it is written; a record that fails validation is rejected.",
  ];
  if (noted.length > 0) {
    lines.push("", "Dimension-specific caveats:", ...noted.map((dimension) => `- **${dimension.label}**: ${dimension.note!}`));
  }
  return lines.join("\n");
}

export function renderMarkdown(profile: Profile): string {
  const lines = [
    `# Psychological Profile: ${profile.source}`,
    "",
    `Generated by \`typesafe-profiler\` on ${profile.generatedAt} from ${profile.scoredCount} of ${profile.messageCount} messages (${profile.dimensions.length} dimensions).`,
    "",
    "**Heuristic inference from individual messages — not a clinical assessment.**",
    "",
  ];
  if (profile.author) {
    lines.push(`Author: ${profile.author}`, "");
  }
  lines.push(
    "## Summary",
    "",
    summaryTable(profile),
    "",
    "## Details",
    "",
    detailSections(profile),
    "## Evidence",
    "",
    evidenceSection(profile),
    "",
    "## Flagged",
    "",
    flaggedSection(profile),
    "",
    "## Caveats",
    "",
    caveats(profile),
    "",
  );
  return lines.join("\n");
}

export function renderJson(profile: Profile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
