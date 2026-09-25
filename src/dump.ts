import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { QUESTIONS } from "./evaluate.js";
import type { JsonValue } from "./types.js";

/**
 * The exact JSON request body sent to `POST /v1/systemone`. Mirrors
 * `TypeSafeClient.systemOne`, which serializes `{ ...request, model }` for a
 * request of `{ state, questions }` — so the body is `{ state, questions,
 * model }` with the model resolved to the evaluator's model.
 *
 * The body carries no authorization material: the API key travels only in the
 * `Authorization` header, never in the body. `state.content` and
 * `state.mentions` do carry raw message text and mentions, so treat a dump as
 * sensitive.
 */
export function requestBody(
  state: Record<string, JsonValue>,
  model: string,
): Record<string, unknown> {
  return { state, questions: QUESTIONS, model };
}

/** Write one request body as pretty-printed JSON (easy to copy as a code block). */
export function dumpRequest(
  dir: string,
  stem: string,
  index: number,
  body: Record<string, unknown>,
): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${stem}.${index}.json`);
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}

/** Write a manifest mapping each message index to a short content preview. */
export function writeDumpManifest(
  dir: string,
  stem: string,
  entries: ReadonlyArray<{ index: number; content: string }>,
): void {
  mkdirSync(dir, { recursive: true });
  const lines = entries.map((entry) => {
    const preview = entry.content.replace(/\s+/g, " ").trim().slice(0, 80);
    return `${entry.index}\t${preview}`;
  });
  writeFileSync(join(dir, `${stem}.manifest.txt`), `${lines.join("\n")}\n`);
}
