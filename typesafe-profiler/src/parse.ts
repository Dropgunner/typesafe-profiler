import type { JsonValue, ParsedMessage } from "./types.js";

/**
 * A chat-log parser that auto-detects the message style of a file and splits it
 * into individual messages. One input file is assumed to hold a single user's
 * messages (already filtered), so the detected author is informational.
 *
 * Supported styles, detected by scanning the whole file and picking whichever
 * header pattern dominates:
 * - DiscordChatExporter plaintext: `[2024-01-01 12:00:00] Username#1234: text`
 * - Discord copy-paste: `Username — Today at 12:34 PM` header, body on following lines
 * - Markdown bold author: `**Username**` / `**Username**:` then text
 * - Simple `Author: text` lines
 * - Raw text with no headers: one message per line, or per blank-line-separated block
 */

interface HeaderMatch {
  author: string | null;
  timestamp: string | null;
  content: string;
}

type Style = "dc-exporter" | "copy-paste" | "markdown" | "simple-author" | "raw";

// `[2024-01-01 12:00:00] Username: text`
const DC_RE = /^\[([^\]]+)\]\s*([^:]+):\s*(.*)$/;
// `**Username** text` or `**Username**: text`
const MD_RE = /^\*\*([^*]+)\*\*\s*(?::\s*)?(.*)$/;
// `Username — Today at 12:34 PM` (em dash, en dash, or hyphen before a date/time)
const COPY_RE = /^(.+?)\s+[—–-]\s+(.+)$/;
// `Author: text`
const SIMPLE_RE = /^([A-Za-z][A-Za-z0-9 ._'-]{0,31}):\s+(.+)$/;
// A date or time phrase, used to distinguish copy-paste headers from prose.
const DATE_TIME_RE = /\d{1,2}:\d{2}\s*(?:AM|PM)?|\d{1,2}[/-]\d{1,2}[/-]\d{2,4}|(?:Today|Yesterday)/i;

function matchDc(line: string): HeaderMatch | null {
  const m = DC_RE.exec(line);
  if (!m || !/\d/.test(m[1]!)) return null;
  return { author: m[2]!.trim() || null, timestamp: m[1]!.trim() || null, content: m[3] ?? "" };
}

function matchMarkdown(line: string): HeaderMatch | null {
  const m = MD_RE.exec(line);
  if (!m) return null;
  const author = m[1]!.trim();
  if (!author) return null;
  return { author, timestamp: null, content: m[2] ?? "" };
}

function matchCopyPaste(line: string): HeaderMatch | null {
  const m = COPY_RE.exec(line);
  if (!m || !DATE_TIME_RE.test(m[2]!)) return null;
  return { author: m[1]!.trim() || null, timestamp: m[2]!.trim() || null, content: "" };
}

function matchSimple(line: string): HeaderMatch | null {
  if (line.includes("://")) return null; // skip URLs like "http://…"
  const m = SIMPLE_RE.exec(line);
  if (!m) return null;
  const author = m[1]!.trim();
  if (!author) return null;
  return { author, timestamp: null, content: m[2] ?? "" };
}

/** Assign one line to a header style, or null when it is not a header line. */
function classifyLine(line: string): Exclude<Style, "raw"> | null {
  if (matchDc(line)) return "dc-exporter";
  if (matchMarkdown(line)) return "markdown";
  if (matchCopyPaste(line)) return "copy-paste";
  if (matchSimple(line)) return "simple-author";
  return null;
}

function detectStyle(lines: string[]): Style {
  const counts: Record<Exclude<Style, "raw">, number> = {
    "dc-exporter": 0,
    "copy-paste": 0,
    markdown: 0,
    "simple-author": 0,
  };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const style = classifyLine(line);
    if (style) counts[style] += 1;
  }
  let best: Exclude<Style, "raw"> | null = null;
  for (const style of Object.keys(counts) as Array<Exclude<Style, "raw">>) {
    if (counts[style] > 0 && (best === null || counts[style] > counts[best])) best = style;
  }
  return best ?? "raw";
}

function matcherFor(style: Exclude<Style, "raw">): (line: string) => HeaderMatch | null {
  switch (style) {
    case "dc-exporter":
      return matchDc;
    case "copy-paste":
      return matchCopyPaste;
    case "markdown":
      return matchMarkdown;
    case "simple-author":
      return matchSimple;
  }
}

/** Parse a single-user chat log into individual messages. */
export function parseChatLog(text: string): ParsedMessage[] {
  const lines = text.split(/\r?\n/);
  const style = detectStyle(lines);

  if (style === "raw") {
    return parseRaw(lines);
  }

  const matchHeader = matcherFor(style);
  const messages: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;

  const flush = () => {
    if (current && current.content.trim()) messages.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const header = matchHeader(line);
    if (header) {
      flush();
      const content = header.content.trim();
      if (content) {
        messages.push({
          index: messages.length + 1,
          author: header.author,
          timestamp: header.timestamp,
          channel: null,
          content,
        });
      } else {
        current = {
          index: messages.length + 1,
          author: header.author,
          timestamp: header.timestamp,
          channel: null,
          content: "",
        };
      }
    } else if (current) {
      current.content = current.content ? `${current.content} ${line}` : line;
    } else {
      // Stray content before any header: treat as its own message.
      messages.push({
        index: messages.length + 1,
        author: null,
        timestamp: null,
        channel: null,
        content: line,
      });
    }
  }
  flush();
  return messages;
}

function parseRaw(lines: string[]): ParsedMessage[] {
  const hasBlank = lines.some((l) => l.trim() === "");
  const messages: ParsedMessage[] = [];

  const push = (content: string) => {
    const trimmed = content.trim();
    if (trimmed) {
      messages.push({ index: messages.length + 1, author: null, timestamp: null, channel: null, content: trimmed });
    }
  };

  if (hasBlank) {
    let block = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        push(block);
        block = "";
      } else {
        block = block ? `${block} ${line}` : line;
      }
    }
    push(block);
  } else {
    for (const raw of lines) push(raw.trim());
  }

  return messages;
}

/**
 * Build the structured `state` sent to TypeSafe for one message: the message
 * text plus always-computable lightweight metadata used by behavioral and
 * interaction dimensions.
 */
export function buildState(message: ParsedMessage): Record<string, JsonValue> {
  const content = message.content;
  const words = content.trim().split(/\s+/).filter(Boolean);
  const mentions = Array.from(content.matchAll(/@([\w.-]+)/g), (m) => m[1]!);
  const trimmed = content.trim();
  return {
    content,
    length_chars: content.length,
    length_words: words.length,
    timestamp: message.timestamp,
    channel: message.channel,
    mentions,
    has_link: /\bhttps?:\/\/\S+/i.test(content),
    has_code: /`{1,3}/.test(content),
    is_question: /\?\s*$/.test(trimmed) || /^(how|what|why|when|where|who|can|could|would|should|is|are|does|do|did|will|shall|might|may)\b/i.test(trimmed),
    is_reply: /^>\s/m.test(content) || /\breplying to\b/i.test(content),
  };
}
