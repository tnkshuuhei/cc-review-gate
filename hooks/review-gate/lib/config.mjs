// レビューゲートの設定と状態の読み書き。
// 設定は ~/.claude/review-gate/config.json、
// ブロック回数の記録は ~/.claude/review-gate/state.json に置く。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GATE_DIR = path.join(os.homedir(), ".claude", "review-gate");
const CONFIG_PATH = path.join(GATE_DIR, "config.json");
const STATE_PATH = path.join(GATE_DIR, "state.json");
const LOG_PATH = path.join(GATE_DIR, "log.jsonl");

// 同じターンを何度もブロックし続けると往復が終わらないので上限を設ける。
const DEFAULTS = {
  enabled: true,
  model: "opus",
  effort: "high",
  timeoutSeconds: 600,
  maxBlocksPerTurn: 2,
  // ここに列挙した絶対パス配下ではゲートを動かさない。
  disabledPaths: [],
  // このパターンにマッチするファイルだけの変更なら、レビューをスキップする。
  // scratchpad と一時ディレクトリは成果物ではないので常に対象外。
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

// 同一ターンでのブロック回数。キーは session_id + ターン境界の uuid。
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

  // 古い記録が無限に溜まらないよう、直近 100 件だけ残す。
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
    // ログの失敗でゲート自体を落とさない。
  }
}

export { CONFIG_PATH, STATE_PATH, LOG_PATH };
