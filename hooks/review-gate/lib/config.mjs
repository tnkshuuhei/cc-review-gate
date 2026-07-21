// Reading and writing the gate's configuration and state.
// Configuration lives in ~/.claude/review-gate/config.json;
// the block counts live in ~/.claude/review-gate/state.json.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GATE_DIR = path.join(os.homedir(), ".claude", "review-gate");
const CONFIG_PATH = path.join(GATE_DIR, "config.json");
const STATE_PATH = path.join(GATE_DIR, "state.json");
const LOG_PATH = path.join(GATE_DIR, "log.jsonl");

// Blocking the same turn over and over would mean the round trips never end, hence a limit.
const DEFAULTS = {
  enabled: true,
  model: "opus",
  effort: "high",
  timeoutSeconds: 600,
  maxBlocksPerTurn: 2,
  // The gate never runs under the absolute paths listed here.
  disabledPaths: [],
  // If a turn only changed files matching these patterns, skip the review.
  // Scratchpads and temp directories are not deliverables, so they are always excluded.
  ignoreGlobs: [
    "**/*.md",
    "**/*.mdx",
    "**/*.txt",
    "**/*.lock",
    "**/pnpm-lock.yaml",
    "**/scratchpad/**",
    "/tmp/**",
    "/private/tmp/**",
    "/var/folders/**"
  ]
};

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadConfig() {
  return { ...DEFAULTS, ...readJson(CONFIG_PATH, {}) };
}

export function saveConfig(patch) {
  const next = { ...loadConfig(), ...patch };
  writeJson(CONFIG_PATH, next);
  return next;
}

export function isPathDisabled(config, cwd) {
  if (!cwd) return false;
  return (config.disabledPaths ?? []).some(
    (dir) => cwd === dir || cwd.startsWith(`${dir}${path.sep}`)
  );
}

// How many times this turn has been blocked. Keyed by session_id + turn-boundary uuid.
export function getBlockCount(key) {
  const state = readJson(STATE_PATH, {});
  return state[key]?.count ?? 0;
}

export function recordBlock(key) {
  const state = readJson(STATE_PATH, {});
  const entry = state[key] ?? { count: 0 };
  entry.count += 1;
  entry.at = new Date().toISOString();
  state[key] = entry;

  // Keep only the last 100 records so old entries do not pile up forever.
  const keys = Object.keys(state).sort(
    (a, b) => String(state[a].at ?? "").localeCompare(String(state[b].at ?? ""))
  );
  for (const stale of keys.slice(0, Math.max(0, keys.length - 100))) {
    delete state[stale];
  }

  writeJson(STATE_PATH, state);
  return entry.count;
}

export function appendLog(record) {
  try {
    fs.mkdirSync(GATE_DIR, { recursive: true });
    fs.appendFileSync(
      LOG_PATH,
      `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`
    );
  } catch {
    // A logging failure must never take the gate itself down.
  }
}

export { CONFIG_PATH, STATE_PATH, LOG_PATH };
