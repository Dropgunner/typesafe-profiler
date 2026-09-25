import { readFileSync, writeFileSync } from "node:fs";
import { excerptOf } from "./aggregate.js";
import type { ParsedMessage } from "./types.js";

/**
 * Pattern flagging and matching for bot transcripts.
 *
 * A "flag" is a typed, reusable signature the user observed in a bot (for
 * example one built by a specific creator): a literal substring, a whole-word
 * match, or a regular expression, plus who it is attributed to and a note. The
 * flagged patterns are matched against other transcripts, and matches that carry
 * a parseable timestamp are folded into a time series (bucketed counts) and gap
 * statistics so recurring cadence can be read off without a model call.
 *
 * Matching is local and deterministic; none of this module contacts TypeSafe.
 */

/** How a pattern matches a message's text. */
export type PatternKind = "regex" | "substring" | "word";

/** The valid "kind" values, in display order. */
export const PATTERN_KINDS: readonly PatternKind[] = ["regex", "substring", "word"];

/** A normalized, stored pattern: every field is present. */
export interface BotPattern {
  /** Stable machine key; generated from the label when not supplied. */
  id: string;
  /** Human-readable name. */
  label: string;
  /** Who the pattern is attributed to (the creator, bot farm, or campaign). */
  creator: string;
  /** Grouping label, e.g. "linguistic", "behavioral", "structural". */
  category: string;
  kind: PatternKind;
  /** Regex source (kind "regex") or a literal string (kinds "substring"/"word"). */
  pattern: string;
  /** Regex flags (e.g. "i", "mi"); ignored for "substring"/"word". */
  regexFlags: string;
  /** Case-sensitive literal matching; ignored for "regex". Default false. */
  caseSensitive: boolean;
  /** Free-text note or caveat. Empty when unset. */
  note: string;
  createdAt: string;
  updatedAt: string;
}

/** What the user provides when flagging a pattern; id and timestamps are filled in. */
export interface PatternInput {
  id?: string;
  label: string;
  creator: string;
  category: string;
  kind: PatternKind;
  pattern: string;
  regexFlags?: string;
  caseSensitive?: boolean;
  note?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** One matched message for one pattern. */
export interface PatternMatch {
  patternId: string;
  /** 1-based message index. */
  messageIndex: number;
  /** Raw timestamp from the log, or null when it carries none. */
  timestamp: string | null;
  /** The exact matched substring, PII-scrubbed and capped. */
  match: string;
  /** A short window around the match, PII-scrubbed and capped. */
  excerpt: string;
}

/** A short example of a pattern matching a message. */
export interface PatternExample {
  index: number;
  timestamp: string | null;
  match: string;
  excerpt: string;
}

/** Per-pattern match totals and representative examples. */
export interface PatternMatchSummary {
  patternId: string;
  label: string;
  creator: string;
  category: string;
  kind: PatternKind;
  pattern: string;
  /** Number of distinct messages this pattern matched. */
  matches: number;
  firstIndex: number | null;
  lastIndex: number | null;
  examples: PatternExample[];
}

/** One fixed-width time bucket of match counts. */
export interface TimeBucket {
  /** ISO timestamp of the bucket start. */
  start: string;
  count: number;
}

/** Inter-match gap statistics, computed only from timestamped matches. */
export interface GapStats {
  /** Number of timestamped matches the gaps are computed over. */
  matchCount: number;
  /** The chosen bucket width in milliseconds. */
  bucketSpanMs: number;
  meanGapMs: number;
  medianGapMs: number;
  minGapMs: number;
  maxGapMs: number;
  stddevGapMs: number;
  /** stddev/mean; low values indicate a regular, bot-like cadence. */
  coefficientOfVariation: number;
}

/** A full pattern-match scan of one transcript. */
export interface PatternMatchReport {
  source: string;
  generatedAt: string;
  messageCount: number;
  patternsScanned: number;
  /** Number of patterns with at least one match. */
  matchedPatterns: number;
  /** Number of distinct messages that matched at least one pattern. */
  matchedMessages: number;
  /** Total (pattern, message) match entries. */
  totalMatches: number;
  /** matchedMessages / messageCount, or 0 when no messages were scanned. */
  matchedRate: number;
  patterns: PatternMatchSummary[];
  /** Bucketed counts; empty when no matched message carried a parseable timestamp. */
  timeSeries: TimeBucket[];
  /** Gap statistics; null when fewer than two timestamped matches. */
  gapStats: GapStats | null;
}

/** Maximum number of examples kept per pattern. */
const MAX_EXAMPLES = 5;
/** Target ceiling for the number of time buckets. */
const MAX_BUCKETS = 60;
/** Characters of context kept on each side of a match before scrubbing. */
const CONTEXT_CHARS = 60;

/** Candidate bucket widths, from finest to coarsest. */
const BUCKET_SPANS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
  7 * 24 * 60 * 60_000,
];

const KIND_SET: ReadonlySet<PatternKind> = new Set(PATTERN_KINDS);
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

function fail(message: string): never {
  throw new Error("Pattern validation failed: " + message);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** Derive a stable machine id from a label, or "pattern" when it is empty. */
function slugFor(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = slug || "pattern";
  return base.slice(0, 64).replace(/-+$/g, "");
}

/** Escape regex metacharacters so a literal can be matched verbatim. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
}

/** Compile a pattern's regex source and flags, validating both. */
function compileRegex(pattern: string, flags: string): RegExp {
  try {
    return new RegExp(pattern, flags);
  } catch (error) {
    fail("pattern \"" + pattern + "\" with flags \"" + flags + "\" is not a valid regular expression: " + (error instanceof Error ? error.message : String(error)));
  }
}

/** Validate one pattern and throw on the first violation. */
export function validatePattern(pattern: BotPattern): void {
  if (!ID_RE.test(pattern.id)) fail("id \"" + pattern.id + "\" is not a valid key (lowercase letters, digits, '_' or '-').");
  if (!isNonEmpty(pattern.label)) fail("pattern \"" + pattern.id + "\" is missing its label.");
  if (!isNonEmpty(pattern.creator)) fail("pattern \"" + pattern.id + "\" is missing its creator.");
  if (!isNonEmpty(pattern.category)) fail("pattern \"" + pattern.id + "\" is missing its category.");
  if (!KIND_SET.has(pattern.kind)) fail("pattern \"" + pattern.id + "\" has invalid kind \"" + String(pattern.kind) + "\".");
  if (!isNonEmpty(pattern.pattern)) fail("pattern \"" + pattern.id + "\" is missing its pattern text.");
  if (typeof pattern.regexFlags !== "string") fail("pattern \"" + pattern.id + "\" regexFlags must be a string.");
  if (typeof pattern.caseSensitive !== "boolean") fail("pattern \"" + pattern.id + "\" caseSensitive must be a boolean.");
  if (typeof pattern.note !== "string") fail("pattern \"" + pattern.id + "\" note must be a string.");
  if (!isNonEmpty(pattern.createdAt)) fail("pattern \"" + pattern.id + "\" is missing createdAt.");
  if (!isNonEmpty(pattern.updatedAt)) fail("pattern \"" + pattern.id + "\" is missing updatedAt.");
  if (pattern.kind === "regex") compileRegex(pattern.pattern, pattern.regexFlags);
}

/**
 * Normalize a flagged pattern into a stored record: fills in the id (slugged
 * from the label when absent), the defaults (regexFlags, caseSensitive, note),
 * and the timestamps, then validates the result.
 *
 * @param input - the flag as supplied.
 * @param now - timestamp for createdAt/updatedAt; defaults to the current instant.
 * @param createdAt - preserved createdAt when updating an existing pattern.
 */
export function normalizePattern(input: PatternInput, now: Date = new Date(), createdAt?: string): BotPattern {
  const pattern: BotPattern = {
    id: input.id?.trim() || slugFor(input.label),
    label: input.label,
    creator: input.creator,
    category: input.category,
    kind: input.kind,
    pattern: input.pattern,
    regexFlags: input.regexFlags ?? "",
    caseSensitive: input.caseSensitive ?? false,
    note: input.note ?? "",
    createdAt: createdAt ?? input.createdAt ?? now.toISOString(),
    updatedAt: input.updatedAt ?? now.toISOString(),
  };
  validatePattern(pattern);
  return pattern;
}

/**
 * Coerce an untrusted value (inline --flag JSON or a parsed flag file) into a
 * PatternInput, rejecting wrong types with a clear message. This is the parser
 * boundary for durable input; typed callers may pass PatternInput directly.
 */
export function coercePatternInput(value: unknown): PatternInput {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Each flag must be a JSON object with at least label, creator, category, kind, and pattern.");
  }
  const record = value as Record<string, unknown>;
  const readString = (key: string, required: boolean): string | undefined => {
    const item = record[key];
    if (item === undefined) {
      if (required) throw new Error("Flag is missing required field \"" + key + "\".");
      return undefined;
    }
    if (typeof item !== "string") throw new Error("Flag field \"" + key + "\" must be a string.");
    return item;
  };
  const kind = readString("kind", true) as PatternKind | undefined;
  if (kind !== undefined && !KIND_SET.has(kind)) {
    throw new Error("Flag field \"kind\" must be one of: " + PATTERN_KINDS.join(", ") + ".");
  }
  const caseSensitive = record["caseSensitive"];
  if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
    throw new Error("Flag field \"caseSensitive\" must be a boolean.");
  }
  return {
    id: readString("id", false),
    label: readString("label", true)!,
    creator: readString("creator", true)!,
    category: readString("category", true)!,
    kind: kind!,
    pattern: readString("pattern", true)!,
    regexFlags: readString("regexFlags", false),
    caseSensitive,
    note: readString("note", false),
    createdAt: readString("createdAt", false),
    updatedAt: readString("updatedAt", false),
  };
}

/** A compiled matcher for one pattern. */
interface Matcher {
  (content: string): { index: number; length: number; text: string } | null;
}

/** Compile a validated pattern into a matcher function. */
export function compileMatcher(pattern: BotPattern): Matcher {
  if (pattern.kind === "regex") {
    // g/y are stateful across calls; strip them so the matcher is reusable.
    const regex = compileRegex(pattern.pattern, pattern.regexFlags.replace(/[gy]/g, ""));
    return (content) => {
      const match = regex.exec(content);
      return match ? { index: match.index, length: match[0].length, text: match[0] } : null;
    };
  }
  if (pattern.kind === "word") {
    const regex = new RegExp("\\b" + escapeRegExp(pattern.pattern) + "\\b", pattern.caseSensitive ? "" : "i");
    return (content) => {
      const match = regex.exec(content);
      return match ? { index: match.index, length: match[0].length, text: match[0] } : null;
    };
  }
  const needle = pattern.caseSensitive ? pattern.pattern : pattern.pattern.toLowerCase();
  return (content) => {
    const haystack = pattern.caseSensitive ? content : content.toLowerCase();
    const index = haystack.indexOf(needle);
    return index === -1 ? null : { index, length: needle.length, text: content.slice(index, index + needle.length) };
  };
}

/** A short context window around a match, to be scrubbed and capped. */
function buildWindow(content: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(content.length, index + length + CONTEXT_CHARS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < content.length ? "…" : "";
  return prefix + content.slice(start, end) + suffix;
}

/**
 * Match every pattern against every message, returning one PatternMatch[] per
 * pattern (aligned with the input patterns array). A message matching a pattern
 * multiple times is recorded once, at its first match.
 */
export function matchMessages(
  patterns: readonly BotPattern[],
  messages: readonly ParsedMessage[],
): PatternMatch[][] {
  const matchers = patterns.map(compileMatcher);
  return patterns.map((pattern, index) => {
    const matcher = matchers[index]!;
    const matches: PatternMatch[] = [];
    for (const message of messages) {
      const hit = matcher(message.content);
      if (!hit) continue;
      matches.push({
        patternId: pattern.id,
        messageIndex: message.index,
        timestamp: message.timestamp,
        match: excerptOf(hit.text),
        excerpt: excerptOf(buildWindow(message.content, hit.index, hit.length)),
      });
    }
    return matches;
  });
}

/**
 * Parse a raw log timestamp into milliseconds since the Unix epoch, or null
 * when it carries no parseable date (for example the copy-paste "Today at
 * 10:02 AM" header, which lacks a date).
 */
export function parseTimestampMs(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const direct = Date.parse(trimmed);
  if (Number.isFinite(direct)) return direct;
  // Some exporters put a space instead of "T" between date and time.
  const spaced = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?)$/.exec(trimmed);
  if (spaced) {
    const joined = Date.parse(spaced[1] + "T" + spaced[2]);
    if (Number.isFinite(joined)) return joined;
  }
  return null;
}

/** Pick the finest bucket width that keeps the span within the target count. */
function chooseBucketSpan(minMs: number, maxMs: number): number {
  const span = maxMs - minMs;
  for (const candidate of BUCKET_SPANS_MS) {
    if (span / candidate <= MAX_BUCKETS) return candidate;
  }
  return BUCKET_SPANS_MS[BUCKET_SPANS_MS.length - 1]!;
}

/** Median of a numeric list. */
function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Inter-match gap statistics over sorted, distinct timestamped matches. */
function buildGapStats(tsMs: number[], bucketSpanMs: number): GapStats | null {
  if (tsMs.length < 2) return null;
  const sorted = [...tsMs].sort((a, b) => a - b);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i]! - sorted[i - 1]!);
  const mean = gaps.reduce((acc, gap) => acc + gap, 0) / gaps.length;
  const variance = gaps.reduce((acc, gap) => acc + (gap - mean) ** 2, 0) / gaps.length;
  const stddev = Math.sqrt(variance);
  return {
    matchCount: sorted.length,
    bucketSpanMs,
    meanGapMs: Math.round(mean),
    medianGapMs: Math.round(median(gaps)),
    minGapMs: Math.min(...gaps),
    maxGapMs: Math.max(...gaps),
    stddevGapMs: Math.round(stddev),
    coefficientOfVariation: mean === 0 ? 0 : round3(stddev / mean),
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Scan one transcript against a set of flagged patterns and fold the matches
 * into a report: per-pattern totals and examples, a timestamped time series,
 * and inter-match gap statistics.
 */
export function buildPatternReport(
  source: string,
  patterns: readonly BotPattern[],
  messages: readonly ParsedMessage[],
): PatternMatchReport {
  for (const pattern of patterns) validatePattern(pattern);

  const perPattern = matchMessages(patterns, messages);
  const messageById = new Map<number, ParsedMessage>();
  for (const message of messages) messageById.set(message.index, message);

  let totalMatches = 0;
  const matchedIndexes = new Set<number>();
  const summaries: PatternMatchSummary[] = patterns.map((pattern, index) => {
    const matches = perPattern[index]!;
    totalMatches += matches.length;
    for (const match of matches) matchedIndexes.add(match.messageIndex);
    return {
      patternId: pattern.id,
      label: pattern.label,
      creator: pattern.creator,
      category: pattern.category,
      kind: pattern.kind,
      pattern: pattern.pattern,
      matches: matches.length,
      firstIndex: matches.length > 0 ? matches[0]!.messageIndex : null,
      lastIndex: matches.length > 0 ? matches[matches.length - 1]!.messageIndex : null,
      examples: matches.slice(0, MAX_EXAMPLES).map((match) => ({
        index: match.messageIndex,
        timestamp: match.timestamp,
        match: match.match,
        excerpt: match.excerpt,
      })),
    };
  });

  const matchedPatterns = summaries.filter((summary) => summary.matches > 0).length;
  const matchedMessages = matchedIndexes.size;

  const tsMs: number[] = [];
  for (const index of matchedIndexes) {
    const message = messageById.get(index);
    if (!message?.timestamp) continue;
    const parsed = parseTimestampMs(message.timestamp);
    if (parsed !== null) tsMs.push(parsed);
  }

  let timeSeries: TimeBucket[] = [];
  let gapStats: GapStats | null = null;
  if (tsMs.length > 0) {
    const minMs = Math.min(...tsMs);
    const maxMs = Math.max(...tsMs);
    const span = chooseBucketSpan(minMs, maxMs);
    const start = Math.floor(minMs / span) * span;
    const buckets: TimeBucket[] = [];
    for (let t = start; t <= maxMs; t += span) {
      const count = tsMs.reduce((acc, ms) => (ms >= t && ms < t + span ? acc + 1 : acc), 0);
      buckets.push({ start: new Date(t).toISOString(), count });
    }
    timeSeries = buckets;
    gapStats = buildGapStats(tsMs, span);
  }

  return {
    source,
    generatedAt: new Date().toISOString(),
    messageCount: messages.length,
    patternsScanned: patterns.length,
    matchedPatterns,
    matchedMessages,
    totalMatches,
    matchedRate: messages.length === 0 ? 0 : round3(matchedMessages / messages.length),
    patterns: summaries,
    timeSeries,
    gapStats,
  };
}

const EXCERPT_MAX = 140;

/**
 * Validate a pattern-match report and reject (throw) any record that fails it:
 * integer counts, a 0..1 matched rate, bounded examples and buckets, and valid
 * gap statistics.
 */
export function validatePatternReport(report: PatternMatchReport): void {
  const invalid = (label: string, value: number, min: number, max: number): never => {
    throw new Error("Pattern-match validation failed: " + label + " " + value + " is outside " + min + ".." + max + ".");
  };
  if (!Number.isInteger(report.messageCount) || report.messageCount < 0) invalid("messageCount", report.messageCount, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(report.patternsScanned) || report.patternsScanned < 0) invalid("patternsScanned", report.patternsScanned, 0, Number.MAX_SAFE_INTEGER);
  if (!Number.isInteger(report.matchedPatterns) || report.matchedPatterns < 0 || report.matchedPatterns > report.patternsScanned) {
    invalid("matchedPatterns", report.matchedPatterns, 0, report.patternsScanned);
  }
  if (!Number.isInteger(report.matchedMessages) || report.matchedMessages < 0 || report.matchedMessages > report.messageCount) {
    invalid("matchedMessages", report.matchedMessages, 0, report.messageCount);
  }
  if (!Number.isInteger(report.totalMatches) || report.totalMatches < report.matchedMessages) invalid("totalMatches", report.totalMatches, report.matchedMessages, Number.MAX_SAFE_INTEGER);
  if (!Number.isFinite(report.matchedRate) || report.matchedRate < 0 || report.matchedRate > 1) invalid("matchedRate", report.matchedRate, 0, 1);
  if (report.patterns.length !== report.patternsScanned) {
    throw new Error("Pattern-match validation failed: " + report.patterns.length + " summaries do not match patternsScanned " + report.patternsScanned + ".");
  }
  for (const summary of report.patterns) {
    if (!Number.isInteger(summary.matches) || summary.matches < 0) invalid("pattern \"" + summary.patternId + "\" matches", summary.matches, 0, Number.MAX_SAFE_INTEGER);
    if (summary.matches === 0 && (summary.firstIndex !== null || summary.lastIndex !== null)) {
      throw new Error("Pattern-match validation failed: pattern \"" + summary.patternId + "\" has no matches but carries indices.");
    }
    if (summary.matches > 0 && (summary.firstIndex === null || summary.lastIndex === null)) {
      throw new Error("Pattern-match validation failed: pattern \"" + summary.patternId + "\" has matches but no indices.");
    }
    if (summary.examples.length > MAX_EXAMPLES) {
      throw new Error("Pattern-match validation failed: pattern \"" + summary.patternId + "\" exceeds " + MAX_EXAMPLES + " examples.");
    }
    for (const example of summary.examples) {
      if (!Number.isInteger(example.index) || example.index < 1 || example.index > report.messageCount) {
        invalid("pattern \"" + summary.patternId + "\" example index", example.index, 1, report.messageCount);
      }
      if (typeof example.match !== "string" || example.match.length === 0 || example.match.length > EXCERPT_MAX) {
        throw new Error("Pattern-match validation failed: pattern \"" + summary.patternId + "\" has an invalid example match.");
      }
      if (typeof example.excerpt !== "string" || example.excerpt.length === 0 || example.excerpt.length > EXCERPT_MAX) {
        throw new Error("Pattern-match validation failed: pattern \"" + summary.patternId + "\" has an invalid example excerpt.");
      }
    }
  }
  let previous = -Infinity;
  for (const bucket of report.timeSeries) {
    if (typeof bucket.start !== "string" || !Number.isFinite(Date.parse(bucket.start))) {
      throw new Error("Pattern-match validation failed: time bucket start \"" + String(bucket.start) + "\" is not a timestamp.");
    }
    if (!Number.isInteger(bucket.count) || bucket.count < 0) invalid("time bucket count", bucket.count, 0, Number.MAX_SAFE_INTEGER);
    const startMs = Date.parse(bucket.start);
    if (startMs <= previous) throw new Error("Pattern-match validation failed: time buckets are not strictly ascending.");
    previous = startMs;
  }
  if (report.gapStats !== null) {
    const gap = report.gapStats;
    if (!Number.isInteger(gap.matchCount) || gap.matchCount < 2) invalid("gap matchCount", gap.matchCount, 2, Number.MAX_SAFE_INTEGER);
    if (!Number.isInteger(gap.bucketSpanMs) || gap.bucketSpanMs < 1) invalid("gap bucketSpanMs", gap.bucketSpanMs, 1, Number.MAX_SAFE_INTEGER);
    for (const key of ["meanGapMs", "medianGapMs", "minGapMs", "maxGapMs", "stddevGapMs"] as const) {
      if (!Number.isInteger(gap[key]) || gap[key] < 0) invalid("gap " + key, gap[key], 0, Number.MAX_SAFE_INTEGER);
    }
    if (!Number.isFinite(gap.coefficientOfVariation) || gap.coefficientOfVariation < 0) invalid("gap coefficientOfVariation", gap.coefficientOfVariation, 0, Number.MAX_SAFE_INTEGER);
  }
}

/** Load a pattern store from a JSON file, or an empty list when it is absent. */
export function loadPatternStore(path: string): BotPattern[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("Pattern store " + path + " must be a JSON array.");
  return parsed.map((item) => normalizePattern(coercePatternInput(item)));
}

/** Write a pattern store as pretty-printed JSON, validating every pattern first. */
export function savePatternStore(path: string, patterns: readonly BotPattern[]): void {
  for (const pattern of patterns) validatePattern(pattern);
  writeFileSync(path, JSON.stringify(patterns, null, 2) + "\n");
}

function fmtMs(ms: number): string {
  if (ms < 1000) return ms + " ms";
  const seconds = ms / 1000;
  if (seconds < 60) return round3(seconds) + " s";
  const minutes = seconds / 60;
  if (minutes < 60) return round3(minutes) + " min";
  const hours = minutes / 60;
  if (hours < 24) return round3(hours) + " h";
  return round3(hours / 24) + " d";
}

/** A short qualitative reading of a coefficient of variation. */
function regularity(cv: number): string {
  if (cv < 0.3) return "highly regular cadence (a bot-like signature)";
  if (cv < 0.7) return "moderately regular";
  return "irregular";
}

/** A compact ASCII bar for one bucket's count, scaled to the series maximum. */
function bar(count: number, max: number): string {
  if (count === 0 || max === 0) return "";
  const width = Math.max(1, Math.round((count / max) * 20));
  return "█".repeat(width);
}

function patternFieldLine(pattern: PatternMatchSummary): string {
  const parts = ["Creator: " + pattern.creator, "Category: " + pattern.category, "Kind: " + pattern.kind];
  if (pattern.kind === "regex") parts.push("Pattern: /" + pattern.pattern + "/");
  else parts.push("Pattern: \"" + pattern.pattern + "\"");
  return parts.join(" · ");
}

function patternsSection(report: PatternMatchReport): string {
  const sections: string[] = [];
  for (const summary of report.patterns) {
    const lines = ["### " + summary.label + " (" + summary.patternId + ")", "", patternFieldLine(summary)];
    if (summary.matches === 0) {
      lines.push("", "No matches in this transcript.");
    } else {
      const range = summary.firstIndex === summary.lastIndex ? String(summary.firstIndex) : summary.firstIndex + "–" + summary.lastIndex;
      lines.push("", "Matches: " + summary.matches + " message(s) (indices " + range + ").", "", "Examples:");
      for (const example of summary.examples) {
        lines.push("- #" + example.index + ": \"" + example.excerpt + "\"");
      }
    }
    sections.push(lines.join("\n"));
  }
  return sections.join("\n\n");
}

function timeSeriesSection(report: PatternMatchReport): string {
  if (report.timeSeries.length === 0) {
    return "No timestamped matches: the transcript carries no parseable timestamps, so no time series could be built.";
  }
  const max = Math.max(...report.timeSeries.map((bucket) => bucket.count));
  const lines = ["| Bucket start (UTC) | Matches |", "| --- | --- |"];
  for (const bucket of report.timeSeries) {
    lines.push("| " + bucket.start + " | " + bucket.count + " " + bar(bucket.count, max) + " |");
  }
  return lines.join("\n");
}

function gapSection(report: PatternMatchReport): string {
  if (report.gapStats === null) return "Not computed: fewer than two timestamped matches.";
  const gap = report.gapStats;
  const lines = [
    "| Statistic | Value |",
    "| --- | --- |",
    "| Timestamped matches | " + gap.matchCount + " |",
    "| Bucket width | " + fmtMs(gap.bucketSpanMs) + " |",
    "| Mean gap | " + fmtMs(gap.meanGapMs) + " |",
    "| Median gap | " + fmtMs(gap.medianGapMs) + " |",
    "| Min / max gap | " + fmtMs(gap.minGapMs) + " / " + fmtMs(gap.maxGapMs) + " |",
    "| Std dev | " + fmtMs(gap.stddevGapMs) + " |",
    "| Coefficient of variation | " + gap.coefficientOfVariation.toFixed(3) + " — " + regularity(gap.coefficientOfVariation) + " |",
  ];
  return lines.join("\n");
}

/** Render a pattern-match report as Markdown. */
export function renderPatternMarkdown(report: PatternMatchReport): string {
  const rate = (report.matchedRate * 100).toFixed(1);
  const lines = [
    "# Pattern-Match Report: " + report.source,
    "",
    "Generated by typesafe-profiler --match on " + report.generatedAt + ": " + report.matchedMessages + " of " + report.messageCount + " messages matched " + report.matchedPatterns + " of " + report.patternsScanned + " flagged patterns (" + report.totalMatches + " total matches, " + rate + "% of messages).",
    "",
    "**Heuristic signature matching — flags are user-defined patterns, not proof of identity or origin.**",
    "",
    "## Patterns",
    "",
    patternsSection(report),
    "",
    "## Time series",
    "",
    timeSeriesSection(report),
    "",
    "## Gap analysis",
    "",
    gapSection(report),
    "",
    "## Caveats",
    "",
    "A flag is a string/regex signature you observed in a bot; matching it in another transcript is evidence of a similar signature, not attribution to the same creator. Matches are counted once per message per pattern. Time-series and gap statistics use only matches whose log entries carry a parseable timestamp; the coefficient of variation is low when matches recur on a regular cadence. Always treat a match as a lead to verify, not a conclusion.",
    "",
  ];
  return lines.join("\n");
}

/** Render a pattern-match report as JSON. */
export function renderPatternJson(report: PatternMatchReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}
