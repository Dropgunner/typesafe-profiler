#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { aggregate } from "./aggregate.js";
import {
  aggregateBotReport,
  BOT_DIMENSIONS,
  renderBotJson,
  renderBotMarkdown,
  validateBotReport,
} from "./botdetect.js";
import { DIMENSIONS } from "./dimensions.js";
import { dumpRequest, requestBody, writeDumpManifest } from "./dump.js";
import {
  BotDryRunEvaluator,
  BotTypeSafeEvaluator,
  DryRunEvaluator,
  GuardDryRunEvaluator,
  GuardTypeSafeEvaluator,
  TypeSafeEvaluator,
  mapWithConcurrency,
} from "./evaluate.js";
import { GUARD_POLICIES, guardProfile, renderGuardJson, renderGuardMarkdown, validateGuardReport } from "./guard.js";
import type { GuardEvaluator } from "./guard.js";
import { buildState, parseChatLog } from "./parse.js";
import { renderJson, renderMarkdown } from "./report.js";
import { validateProfile } from "./schema.js";
import { resolveApiKey, storeApiKeyToKeychain } from "./secrets.js";
import {
  buildPatternReport,
  coercePatternInput,
  loadPatternStore,
  normalizePattern,
  renderPatternJson,
  renderPatternMarkdown,
  savePatternStore,
  validatePatternReport,
} from "./patterns.js";
import type { BotPattern, PatternInput } from "./patterns.js";
import type { BotEvaluator, BotTurnEvaluation } from "./botdetect.js";
import type { Evaluator, ParsedMessage } from "./types.js";

const VERSION = "0.3.0";

const TEXT_EXTENSIONS = new Set([".txt", ".md", ".markdown", ".log"]);

const HELP = `typesafe-profiler ${VERSION} — score chat logs across psychological dimensions via TypeSafe

Usage:
  typesafe-profiler [files or directories...] [options]

Each input file should hold one user's chat log. The message format is
auto-detected: DiscordChatExporter plaintext, Discord copy-paste, Markdown,
"Author: text" lines, or raw text.

Options:
  -o, --out <dir>          Output directory (default: ./profile-output)
  -c, --concurrency <n>    Parallel TypeSafe calls (default: 4)
  -l, --limit <n>          Max messages to score per file; 0 = unlimited (default: 200)
      --format <f>         Output format: both | md | json (default: both)
      --model <name>       TypeSafe model (default: jev-latest)
      --timeout <ms>       Per-call timeout in milliseconds (default: 30000)
      --dump-requests <dir>  Write each TypeSafe request body (state + questions + model, no auth headers) as JSON files
      --api-key <key>      Use this key (least safe; visible in process list)
      --store-key          Save the key to the macOS Keychain (prompts securely)
      --detect             Run the analogue bot-detection battery instead of the human profile
      --guard              Route the profile to pass/review/block/support under a guard policy
      --guard-policy <name>  Routing policy: strict | permissive (default: strict)
      --match              Scan inputs against your flagged patterns (no API key needed)
      --patterns <file>    Pattern store JSON file (default: ./.bot-patterns.json)
      --flag <json|file>   Add one or more patterns to the store (JSON object, array, or a file path)
      --list-patterns      Print the pattern store and exit
      --remove-pattern <id> Remove one pattern from the store by id and exit
      --dry-run            Use deterministic fake scores; no API key needed
      --verbose            Log per-message progress
  -h, --help               Show this help
  -v, --version            Show the version

API key resolution order: --api-key, TYPESAFE_API_KEY env var, ./.env file,
macOS Keychain (service "typesafe-api-key").
`;

interface Options {
  paths: string[];
  out: string;
  concurrency: number;
  limit: number;
  format: "both" | "md" | "json";
  model: string;
  timeoutMs: number;
  dumpRequests?: string;
  dryRun: boolean;
  verbose: boolean;
  storeKey: boolean;
  detect: boolean;
  guard: boolean;
  guardPolicy: string;
  match: boolean;
  patterns: string;
  flagValues: string[];
  listPatterns: boolean;
  removePattern?: string;
  apiKey?: string;
  help: boolean;
  version: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    paths: [],
    out: "profile-output",
    concurrency: 4,
    limit: 200,
    format: "both",
    model: "jev-latest",
    timeoutMs: 30_000,
    dryRun: false,
    verbose: false,
    storeKey: false,
    detect: false,
    guard: false,
    guardPolicy: "strict",
    match: false,
    patterns: ".bot-patterns.json",
    flagValues: [],
    listPatterns: false,
    help: false,
    version: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const takeValue = (flag: string): string => {
      if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
      const next = argv[i + 1];
      if (next === undefined) throw new Error(`${flag} requires a value.`);
      i += 1;
      return next;
    };

    if (arg === "-h" || arg === "--help") {
      options.help = true;
    } else if (arg === "-v" || arg === "--version") {
      options.version = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--detect") {
      options.detect = true;
    } else if (arg === "--guard") {
      options.guard = true;
    } else if (arg === "--guard-policy" || arg.startsWith("--guard-policy=")) {
      options.guardPolicy = takeValue("--guard-policy");
    } else if (arg === "--match") {
      options.match = true;
    } else if (arg === "--list-patterns") {
      options.listPatterns = true;
    } else if (arg === "--patterns" || arg.startsWith("--patterns=")) {
      options.patterns = takeValue("--patterns");
    } else if (arg === "--flag" || arg.startsWith("--flag=")) {
      options.flagValues.push(takeValue("--flag"));
    } else if (arg === "--remove-pattern" || arg.startsWith("--remove-pattern=")) {
      options.removePattern = takeValue("--remove-pattern");
    } else if (arg === "--store-key") {
      options.storeKey = true;
    } else if (arg === "--verbose") {
      options.verbose = true;
    } else if (arg === "-o" || arg === "--out" || arg.startsWith("--out=")) {
      options.out = takeValue("--out");
    } else if (arg === "-c" || arg === "--concurrency" || arg.startsWith("--concurrency=")) {
      options.concurrency = Number(takeValue("--concurrency"));
    } else if (arg === "-l" || arg === "--limit" || arg.startsWith("--limit=")) {
      options.limit = Number(takeValue("--limit"));
    } else if (arg === "--format" || arg.startsWith("--format=")) {
      options.format = takeValue("--format") as Options["format"];
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      options.model = takeValue("--model");
    } else if (arg === "--timeout" || arg.startsWith("--timeout=")) {
      options.timeoutMs = Number(takeValue("--timeout"));
    } else if (arg === "--dump-requests" || arg.startsWith("--dump-requests=")) {
      options.dumpRequests = takeValue("--dump-requests");
    } else if (arg === "--api-key" || arg.startsWith("--api-key=")) {
      options.apiKey = takeValue("--api-key");
    } else if (arg.startsWith("-") && arg !== "-") {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.paths.push(arg);
    }
  }

  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error("--concurrency must be an integer >= 1.");
  if (!Number.isInteger(options.limit) || options.limit < 0) throw new Error("--limit must be an integer >= 0 (0 = unlimited).");
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1) throw new Error("--timeout must be a positive number.");
  if (!["both", "md", "json"].includes(options.format)) throw new Error("--format must be one of: both, md, json.");
  if (options.match && options.detect) throw new Error("--match and --detect are mutually exclusive; choose one mode.");
  if (options.guard && options.detect) throw new Error("--guard and --detect are mutually exclusive; choose one mode.");
  if (options.guard && options.match) throw new Error("--guard and --match are mutually exclusive; choose one mode.");
  if (!(options.guardPolicy in GUARD_POLICIES)) {
    throw new Error(`--guard-policy must be one of: ${Object.keys(GUARD_POLICIES).join(", ")}.`);
  }
  return options;
}

function collectFiles(paths: string[]): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      const stats = statSync(full);
      if (stats.isDirectory()) walk(full);
      else if (stats.isFile() && TEXT_EXTENSIONS.has(extname(entry).toLowerCase())) found.push(full);
    }
  };
  for (const path of paths) {
    const stats = statSync(path);
    if (stats.isDirectory()) walk(path);
    else if (stats.isFile()) found.push(path);
    else throw new Error(`No such file or directory: ${path}`);
  }
  return [...new Set(found)].sort();
}

function outputStem(file: string): string {
  const base = basename(file);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runFile(evaluator: Evaluator, file: string, options: Options): Promise<void> {
  const text = readFileSync(file, "utf8");
  const messages: ParsedMessage[] = parseChatLog(text);
  const limited = options.limit > 0 ? messages.slice(0, options.limit) : messages;
  if (limited.length === 0) {
    console.log(`[skip] ${file}: no messages parsed`);
    return;
  }
  if (options.verbose) console.log(`[eval] ${file}: ${limited.length} message(s)`);

  // A dry run never reaches TypeSafe, so there is no request body to capture.
  const dumpDir = options.dryRun ? undefined : options.dumpRequests;

  const evaluated = await mapWithConcurrency(limited, options.concurrency, async (message) => {
    const state = buildState(message);
    if (dumpDir) {
      dumpRequest(dumpDir, outputStem(file), message.index, requestBody(state, options.model));
    }
    try {
      return await evaluator.evaluate(state);
    } catch (error) {
      console.error(`[error] ${file} message ${message.index}: ${errorMessage(error)}`);
      return null;
    }
  });

  if (dumpDir) {
    writeDumpManifest(dumpDir, outputStem(file), limited.map((message) => ({ index: message.index, content: message.content })));
    console.log(`[dump] wrote ${limited.length} request bod${limited.length === 1 ? "y" : "ies"} to ${dumpDir}/${outputStem(file)}.{<index>.json,manifest.txt}`);
  }

  let inputTokens = 0;
  let outputTokens = 0;
  for (const result of evaluated) {
    if (!result) continue;
    inputTokens += result.usage.input_tokens;
    outputTokens += result.usage.output_tokens;
  }

  const author = limited.find((message) => message.author)?.author ?? null;
  const profile = aggregate(file, author, limited, evaluated, { input_tokens: inputTokens, output_tokens: outputTokens });
  validateProfile(profile);

  const stem = join(options.out, outputStem(file));
  if (options.format === "md" || options.format === "both") writeFileSync(`${stem}.md`, renderMarkdown(profile));
  if (options.format === "json" || options.format === "both") writeFileSync(`${stem}.json`, renderJson(profile));

  console.log(`[done] ${file} -> ${outputStem(file)}.{md,json}: ${profile.scoredCount}/${profile.messageCount} messages, ${profile.dimensions.length} dimensions`);
}

async function runDetectFile(evaluator: BotEvaluator, file: string, options: Options): Promise<void> {
  const text = readFileSync(file, "utf8");
  const turns: ParsedMessage[] = parseChatLog(text);
  const limited = options.limit > 0 ? turns.slice(0, options.limit) : turns;
  if (limited.length === 0) {
    console.log(`[skip] ${file}: no turns parsed`);
    return;
  }
  if (options.verbose) console.log(`[detect] ${file}: ${limited.length} turn(s)`);

  const evaluated = await mapWithConcurrency(limited, options.concurrency, async (turn) => {
    const state = buildState(turn);
    try {
      return (await evaluator.evaluateBotTurn(state)) satisfies BotTurnEvaluation;
    } catch (error) {
      console.error(`[error] ${file} turn ${turn.index}: ${errorMessage(error)}`);
      return null;
    }
  });

  let inputTokens = 0;
  let outputTokens = 0;
  for (const result of evaluated) {
    if (!result) continue;
    inputTokens += result.usage.input_tokens;
    outputTokens += result.usage.output_tokens;
  }

  const report = aggregateBotReport(file, limited, evaluated, {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
  });
  validateBotReport(report);

  const stem = join(options.out, outputStem(file));
  if (options.format === "md" || options.format === "both") writeFileSync(`${stem}.detect.md`, renderBotMarkdown(report));
  if (options.format === "json" || options.format === "both") writeFileSync(`${stem}.detect.json`, renderBotJson(report));

  console.log(
    `[done] ${file} -> ${outputStem(file)}.detect.{md,json}: ${report.scoredCount}/${report.turnCount} turns, ${report.dimensions.length} dimensions, ${report.verdict} (${report.likelihood})`,
  );
}

async function runGuardFile(evaluator: GuardEvaluator, file: string, options: Options): Promise<void> {
  const text = readFileSync(file, "utf8");
  const messages: ParsedMessage[] = parseChatLog(text);
  const limited = options.limit > 0 ? messages.slice(0, options.limit) : messages;
  if (limited.length === 0) {
    console.log(`[skip] ${file}: no messages parsed`);
    return;
  }
  if (options.verbose) console.log(`[guard] ${file}: ${limited.length} message(s)`);

  const evaluated = await mapWithConcurrency(limited, options.concurrency, async (message) => {
    const state = buildState(message);
    try {
      return await evaluator.evaluateGuard(state);
    } catch (error) {
      console.error(`[error] ${file} message ${message.index}: ${errorMessage(error)}`);
      return null;
    }
  });

  let inputTokens = 0;
  let outputTokens = 0;
  for (const result of evaluated) {
    if (!result) continue;
    inputTokens += result.usage.input_tokens;
    outputTokens += result.usage.output_tokens;
  }

  const author = limited.find((message) => message.author)?.author ?? null;
  const profile = aggregate(file, author, limited, evaluated, { input_tokens: inputTokens, output_tokens: outputTokens });
  validateProfile(profile);

  let selfHarmMax = 0;
  let severityMax = 0;
  for (const result of evaluated) {
    if (!result) continue;
    selfHarmMax = Math.max(selfHarmMax, result.selfHarm);
    severityMax = Math.max(severityMax, result.severity);
  }

  const report = guardProfile(
    profile,
    { selfHarm: selfHarmMax, severity: severityMax },
    options.guardPolicy,
    { input_tokens: inputTokens, output_tokens: outputTokens },
  );
  validateGuardReport(report);

  const stem = join(options.out, outputStem(file));
  if (options.format === "md" || options.format === "both") writeFileSync(`${stem}.guard.md`, renderGuardMarkdown(report));
  if (options.format === "json" || options.format === "both") writeFileSync(`${stem}.guard.json`, renderGuardJson(report));

  console.log(`[done] ${file} -> ${outputStem(file)}.guard.{md,json}: ${report.action} (policy ${report.policy})`);
}

/** Parse one or more --flag values (inline JSON or a JSON file) into pattern inputs. */
function flagInputsFromValues(values: string[]): PatternInput[] {
  const inputs: PatternInput[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    const parsed: unknown = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : JSON.parse(readFileSync(trimmed, "utf8"));
    if (Array.isArray(parsed)) {
      for (const item of parsed) inputs.push(coercePatternInput(item));
    } else {
      inputs.push(coercePatternInput(parsed));
    }
  }
  return inputs;
}

/** Scan one file against the pattern store and write a match report. */
function runMatchFile(store: readonly BotPattern[], file: string, options: Options): void {
  const text = readFileSync(file, "utf8");
  const messages: ParsedMessage[] = parseChatLog(text);
  if (messages.length === 0) {
    console.log("[skip] " + file + ": no messages parsed");
    return;
  }
  const report = buildPatternReport(file, store, messages);
  validatePatternReport(report);

  const stem = join(options.out, outputStem(file));
  if (options.format === "md" || options.format === "both") writeFileSync(stem + ".patterns.md", renderPatternMarkdown(report));
  if (options.format === "json" || options.format === "both") writeFileSync(stem + ".patterns.json", renderPatternJson(report));

  console.log(
    "[done] " + file + " -> " + outputStem(file) + ".patterns.{md,json}: " + report.matchedMessages + "/" + report.messageCount + " messages matched, " + report.matchedPatterns + "/" + report.patternsScanned + " patterns, " + report.totalMatches + " total matches",
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    console.log(HELP);
    return;
  }
  if (options.version) {
    console.log(VERSION);
    return;
  }
  if (options.storeKey) {
    await storeApiKeyToKeychain();
    console.log("The key will now be read automatically from the macOS Keychain.");
    return;
  }
  if (options.listPatterns) {
    console.log(JSON.stringify(loadPatternStore(options.patterns), null, 2));
    return;
  }
  if (options.removePattern) {
    const store = loadPatternStore(options.patterns);
    const next = store.filter((pattern) => pattern.id !== options.removePattern);
    if (next.length === store.length) {
      console.error('No pattern with id "' + options.removePattern + '" in ' + options.patterns + ".");
      process.exitCode = 1;
      return;
    }
    savePatternStore(options.patterns, next);
    console.log('Removed pattern "' + options.removePattern + '" (' + next.length + " remaining in " + options.patterns + ").");
    return;
  }
  if (options.flagValues.length > 0) {
    const inputs = flagInputsFromValues(options.flagValues);
    const byId = new Map<string, BotPattern>();
    for (const pattern of loadPatternStore(options.patterns)) byId.set(pattern.id, pattern);
    for (const input of inputs) {
      const candidate = normalizePattern(input);
      const existing = byId.get(candidate.id);
      const pattern = existing ? { ...candidate, createdAt: existing.createdAt } : candidate;
      byId.set(pattern.id, pattern);
      console.log((existing ? "[updated] " : "[added] ") + pattern.id + " (" + pattern.kind + ": " + pattern.pattern + ")");
    }
    savePatternStore(options.patterns, [...byId.values()]);
    console.log("Stored " + byId.size + " pattern(s) in " + options.patterns + ".");
    return;
  }
  if (options.paths.length === 0) {
    console.error("No input files. Provide one or more file or directory paths.");
    console.error("");
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const files = collectFiles(options.paths);
  if (files.length === 0) {
    console.error("No text files found in the given paths.");
    process.exitCode = 1;
    return;
  }

  if (options.match) {
    const store = loadPatternStore(options.patterns);
    if (store.length === 0) {
      console.error("No flagged patterns in " + options.patterns + ". Add some with --flag first.");
      process.exitCode = 1;
      return;
    }
    mkdirSync(options.out, { recursive: true });
    let failures = 0;
    for (const file of files) {
      try {
        runMatchFile(store, file, options);
      } catch (error) {
        failures += 1;
        console.error("[error] " + file + ": " + errorMessage(error));
      }
    }
    console.log("\nScanned " + files.length + " file(s) against " + store.length + " flagged pattern(s).");
    if (failures > 0) {
      console.error(failures + " file(s) failed.");
      process.exitCode = 1;
    }
    return;
  }

  let evaluator: Evaluator;
  let botEvaluator: BotEvaluator;
  let guardEvaluator: GuardEvaluator;
  if (options.dryRun) {
    evaluator = new DryRunEvaluator();
    botEvaluator = new BotDryRunEvaluator();
    guardEvaluator = new GuardDryRunEvaluator();
  } else {
    const resolved = await resolveApiKey(options.apiKey);
    console.log(`Using TypeSafe API key from: ${resolved.source}`);
    evaluator = new TypeSafeEvaluator({ apiKey: resolved.key, model: options.model, timeoutMs: options.timeoutMs });
    botEvaluator = new BotTypeSafeEvaluator({ apiKey: resolved.key, model: options.model, timeoutMs: options.timeoutMs });
    guardEvaluator = new GuardTypeSafeEvaluator({ apiKey: resolved.key, model: options.model, timeoutMs: options.timeoutMs });
  }

  if (options.dryRun && options.dumpRequests) {
    console.log("[dump] --dry-run makes no TypeSafe calls; --dump-requests is ignored.");
  }

  mkdirSync(options.out, { recursive: true });

  let failures = 0;
  for (const file of files) {
    try {
      if (options.detect) await runDetectFile(botEvaluator, file, options);
      else if (options.guard) await runGuardFile(guardEvaluator, file, options);
      else await runFile(evaluator, file, options);
    } catch (error) {
      failures += 1;
      console.error(`[error] ${file}: ${errorMessage(error)}`);
    }
  }

  const dimensionCount = options.detect ? BOT_DIMENSIONS.length : DIMENSIONS.length;
  console.log(`\nProcessed ${files.length} file(s) across ${dimensionCount} dimensions${options.guard ? " plus the self-harm and severity safety battery" : ""}.`);
  if (options.dryRun) console.log("Dry-run: scores are deterministic fakes, not TypeSafe results.");
  if (options.detect) console.log("Bot detection is a heuristic analogue battery, not proof of identity.");
  if (options.guard) console.log(`Guard routing is a heuristic signal, not a decision about the person (policy ${options.guardPolicy}).`);
  if (failures > 0) {
    console.error(`${failures} file(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`[fatal] ${errorMessage(error)}`);
  process.exitCode = 1;
});
