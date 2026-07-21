// レビュアの起動。claude を -p (headless) で読み取り専用に立ち上げ、
// 1 行目の ALLOW: / BLOCK: だけを判定に使う。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// 子プロセスの Stop フックが再びゲートを起動して無限に入れ子になるのを防ぐ目印。
export const GUARD_ENV = "CLAUDE_REVIEW_GATE_ACTIVE";

// レビュアに渡すツール。書き込み系は最初から渡さない。
const ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Bash(git diff:*)",
  "Bash(git status:*)",
  "Bash(git log:*)",
  "Bash(git show:*)",
  "Bash(git rev-parse:*)",
  "Bash(git blame:*)"
];

function resolveClaudeBin() {
  const candidates = [
    process.env.CLAUDE_REVIEW_GATE_BIN,
    path.join(os.homedir(), ".local", "bin", "claude"),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  const found = spawnSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" });
  const fromPath = String(found.stdout ?? "").trim();
  return fromPath || null;
}

export function buildPrompt({ changedFiles, assistantText }) {
  const template = fs.readFileSync(path.join(ROOT_DIR, "prompts", "review.md"), "utf8");

  const filesBlock =
    changedFiles.length > 0
      ? changedFiles.map((file) => `- ${file}`).join("\n")
      : "(ファイル一覧を特定できなかった。git status / git diff から自分で範囲を判断すること)";

  const assistantBlock = assistantText
    ? [
        "What the previous session said it did (unverified — treat as a claim, not evidence):",
        "<previous_turn_summary>",
        assistantText.slice(0, 8000),
        "</previous_turn_summary>"
      ].join("\n")
      : "";

  return template
    .replace("{{CHANGED_FILES}}", filesBlock)
    .replace("{{ASSISTANT_TEXT_BLOCK}}", assistantBlock);
}

// 出力の 1 行目だけを見る。判定できない出力は「通す」に倒す。
// レビュア側の事故で作業が止まる方が、見落としより体験を壊すため。
export function parseVerdict(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return { blocked: false, note: "レビュアが空の応答を返した" };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW")) {
    return { blocked: false, note: firstLine };
  }
  if (firstLine.startsWith("BLOCK")) {
    return { blocked: true, reason: text.replace(/^BLOCK:\s*/, "").trim() };
  }
  return { blocked: false, note: `レビュアの応答形式が不正: ${firstLine.slice(0, 120)}` };
}

export function runReviewer({ cwd, prompt, config }) {
  const bin = resolveClaudeBin();
  if (!bin) {
    return { blocked: false, note: "claude 実行ファイルが見つからずレビューをスキップ" };
  }

  // --setting-sources は指定しない。空にすると設定ファイルだけでなく
  // CLAUDE.md まで読まれなくなり、プロジェクト規範を知らないレビュアになる。
  // MCP とスキルはレビューに使わないので切る（起動時 19.4k → 9.1k tok）。
  const args = [
    "-p",
    "--output-format",
    "json",
    "--model",
    config.model,
    "--effort",
    config.effort,
    "--strict-mcp-config",
    "--mcp-config",
    '{"mcpServers":{}}',
    "--disable-slash-commands",
    "--tools",
    "Read,Grep,Glob,Bash",
    "--allowedTools",
    ...ALLOWED_TOOLS,
    "--permission-mode",
    "dontAsk",
    "--no-session-persistence",
    prompt
  ];

  const result = spawnSync(bin, args, {
    cwd,
    encoding: "utf8",
    timeout: config.timeoutSeconds * 1000,
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, [GUARD_ENV]: "1" }
  });

  if (result.error?.code === "ETIMEDOUT") {
    return {
      blocked: false,
      note: `レビューが ${config.timeoutSeconds}s でタイムアウトした`
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(0, 300);
    return { blocked: false, note: `レビュアが異常終了した: ${detail}` };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { blocked: false, note: "レビュアの出力が JSON として読めなかった" };
  }

  if (payload?.is_error) {
    return { blocked: false, note: `レビュアがエラーを返した: ${payload?.subtype ?? ""}` };
  }

  const verdict = parseVerdict(payload?.result);
  return { ...verdict, costUsd: payload?.total_cost_usd, durationMs: payload?.duration_ms };
}
