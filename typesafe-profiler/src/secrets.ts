import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a resolved API key came from. */
export type KeySource = "cli" | "env" | "env-file" | "keychain";

export interface ResolvedKey {
  key: string;
  source: KeySource;
}

const KEYCHAIN_SERVICE = "apikey_259725beda88d9340b6882b392ae8842fe8_61985baca45b239af19e66bf2e608ff66f5763be35ad81beffbe70c5bbdabfe9	";

function keychainAccount(): string {
  return process.env["USER"] ?? process.env["USERNAME"] ?? "default";
}

/** Parse a `.env` file into a map. Ignores comments, blank lines, and quotes. */
function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith("export ")) key = key.slice("export ".length).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) result[key] = value;
  }
  return result;
}

function loadEnvFile(path: string): Record<string, string> {
  try {
    return parseEnvFile(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

/** The project root, whether running from `src/` (tsx) or `dist/` (built). */
function projectRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Read `TYPESAFE_API_KEY` from `./.env` in the cwd, then the project root. */
function envFileValue(): string | undefined {
  const candidates = [join(process.cwd(), ".env"), join(projectRoot(), ".env")];
  for (const path of candidates) {
    const value = loadEnvFile(path)["TYPESAFE_API_KEY"];
    if (value) return value;
  }
  return undefined;
}

/** Read the key from the macOS Keychain, or undefined when unavailable. */
function readKeychain(): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (process.platform !== "darwin") {
      resolve(undefined);
      return;
    }
    execFile(
      "security",
      ["find-generic-password", "-a", keychainAccount(), "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 5000 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const secret = stdout.trim();
        resolve(secret || undefined);
      },
    );
  });
}

/**
 * Resolve the API key from the most explicit source available: `--api-key`
 * flag, `TYPESAFE_API_KEY` env var, a `.env` file, then the macOS Keychain.
 */
export async function resolveApiKey(cliKey?: string): Promise<ResolvedKey> {
  if (cliKey) return { key: cliKey.trim(), source: "cli" };
  const env = process.env["TYPESAFE_API_KEY"];
  if (env) return { key: env.trim(), source: "env" };
  const fromFile = envFileValue();
  if (fromFile) return { key: fromFile.trim(), source: "env-file" };
  const fromKeychain = await readKeychain();
  if (fromKeychain) return { key: fromKeychain.trim(), source: "keychain" };
  throw new Error(
    "No TYPESAFE_API_KEY found. Provide it via one of:\n" +
      "  - --api-key <key>\n" +
      "  - environment variable: export TYPESAFE_API_KEY=sk-...\n" +
      "  - a .env file in the project (TYPESAFE_API_KEY=sk-...)\n" +
      "  - macOS Keychain: run with --store-key to save it once",
  );
}

/** Prompt for a secret with hidden input, falling back to a stdin line when piped. */
export function promptSecret(question: string): Promise<string> {
  if (process.stdin.isTTY) return hiddenPrompt(question);
  return readStdinLine(question);
}

function hiddenPrompt(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    let value = "";
    const onData = (char: string): void => {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004":
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          resolve(value);
          break;
        case "\u0003":
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          reject(new Error("Cancelled."));
          break;
        case "\u007f":
        case "\b":
          if (value.length > 0) value = value.slice(0, -1);
          break;
        default:
          if (char >= " ") value += char;
      }
    };
    process.stdin.on("data", onData);
  });
}

function readStdinLine(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (question) process.stdout.write(question);
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
    process.stdin.resume();
  });
}

/** Store the key in the macOS Keychain, reading it via a hidden prompt or stdin. */
export async function storeApiKeyToKeychain(): Promise<void> {
  let secret: string;
  if (process.stdin.isTTY) {
    const first = await promptSecret("Enter API key (input hidden): ");
    const second = await promptSecret("Confirm API key: ");
    if (first !== second) throw new Error("Keys do not match.");
    secret = first;
  } else {
    secret = await promptSecret("");
  }
  if (!secret) throw new Error("No key provided.");
  await writeKeychain(secret);
  console.log(`Stored TYPESAFE_API_KEY in the macOS Keychain (service: ${KEYCHAIN_SERVICE}).`);
}

function writeKeychain(secret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (process.platform !== "darwin") {
      reject(new Error("Keychain storage is only available on macOS."));
      return;
    }
    // `security` reads the password and its retype confirmation from stdin when
    // `-w` is given without a value, so the key never appears in argv.
    const child = execFile(
      "security",
      ["add-generic-password", "-U", "-a", keychainAccount(), "-s", KEYCHAIN_SERVICE, "-w"],
      { timeout: 15000 },
      (error) => {
        if (error) reject(new Error(`Failed to store key in Keychain: ${error.message}`));
        else resolve();
      },
    );
    child.stdin?.write(`${secret}\n${secret}\n`);
    child.stdin?.end();
  });
}
