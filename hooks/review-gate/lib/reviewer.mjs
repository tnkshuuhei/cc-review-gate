// Launching the reviewer: claude in -p (headless) mode, read-only, with only the first
// line of its output (ALLOW: / BLOCK:) used as the verdict.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Marker that keeps the child process's Stop hook from starting the gate again and
// nesting forever.
export const GUARD_ENV = "CLAUDE_REVIEW_GATE_ACTIVE";

// The tools handed to the reviewer. Write tools are never handed over in the first place.
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
      : "(The file list could not be determined. Work out the scope yourself from git status / git diff.)";

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

// Only the first line of the output is read. Anything we cannot turn into a verdict
// falls through to "allow": the gate breaking its own way out of the user's work is
// worse than a missed issue.
export function parseVerdict(rawText) {
  const text = String(rawText ?? "").trim();
  if (!text) {
    return { blocked: false, note: "reviewer returned an empty response" };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW")) {
    return { blocked: false, note: firstLine };
  }
  if (firstLine.startsWith("BLOCK")) {
    return { blocked: true, reason: text.replace(/^BLOCK:\s*/, "").trim() };
  }
  return { blocked: false, note: `malformed reviewer response: ${firstLine.slice(0, 120)}` };
}

export function runReviewer({ cwd, prompt, config }) {
  const bin = resolveClaudeBin();
  if (!bin) {
    return { blocked: false, note: "claude executable not found; review skipped" };
  }

  // Deliberately not passing --setting-sources. Emptying it drops not just the settings
  // files but CLAUDE.md too, which would leave the reviewer ignorant of the project's
  // own conventions. MCP and skills are not used for reviewing, so those are cut
  // (19.4k -> 9.1k startup tokens).
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
      note: `review timed out after ${config.timeoutSeconds}s`
    };
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim().slice(0, 300);
    return { blocked: false, note: `reviewer exited abnormally: ${detail}` };
  }

  let payload;
  try {
    payload = JSON.parse(result.stdout);
  } catch {
    return { blocked: false, note: "reviewer output could not be parsed as JSON" };
  }

  if (payload?.is_error) {
    return { blocked: false, note: `reviewer returned an error: ${payload?.subtype ?? ""}` };
  }

  const verdict = parseVerdict(payload?.result);
  return { ...verdict, costUsd: payload?.total_cost_usd, durationMs: payload?.duration_ms };
}
