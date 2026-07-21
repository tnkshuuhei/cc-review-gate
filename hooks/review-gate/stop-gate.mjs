#!/usr/bin/env node
// The Stop hook.
//
// Only when the previous turn changed code: spawn a read-only claude in a separate
// process and have it review. On a BLOCK verdict, emit {"decision":"block"} so the
// session does not stop and keeps working on the fixes instead.
//
// Whenever no verdict can be reached (reviewer crashed, timed out, malformed output),
// always allow. A gate that halts your work through its own accident damages the
// experience more than a missed issue does.

import fs from "node:fs";
import process from "node:process";

import {
  loadConfig,
  isPathDisabled,
  getBlockCount,
  recordBlock,
  appendLog
} from "./lib/config.mjs";
import { analyzeLastTurn, matchesAnyGlob } from "./lib/transcript.mjs";
import { buildPrompt, runReviewer, GUARD_ENV } from "./lib/reviewer.mjs";

function readHookInput() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function allow(reason, extra = {}) {
  appendLog({ decision: "allow", reason, ...extra });
}

function block(reason, extra = {}) {
  appendLog({ decision: "block", reason: reason.slice(0, 500), ...extra });
  process.stdout.write(`${JSON.stringify({ decision: "block", reason })}\n`);
}

function main() {
  // Recursion guard: the reviewer is itself a claude process, and its exit fires this
  // same hook. Bail out before doing anything else.
  if (process.env[GUARD_ENV] === "1") return;

  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig();

  if (!config.enabled) return;
  if (isPathDisabled(config, cwd)) return;

  const turn = analyzeLastTurn(input.transcript_path);

  // Turns with no edits (research, reporting, checking settings) never spawn a reviewer.
  // This is what makes leaving the gate on all the time feel like nothing changed.
  if (turn.changedFiles.length === 0 && turn.editToolCalls === 0) {
    allow("no code changes in the previous turn");
    return;
  }

  const meaningful = turn.changedFiles.filter(
    (file) => !matchesAnyGlob(file, config.ignoreGlobs)
  );
  if (turn.changedFiles.length > 0 && meaningful.length === 0) {
    allow("only ignoreGlobs matches were changed", { files: turn.changedFiles });
    return;
  }

  // Blocking the same turn over and over would mean the round trips never end, so cut
  // it off at the limit.
  const turnKey = `${input.session_id ?? "unknown"}:${turn.boundaryUuid ?? "unknown"}`;
  if (getBlockCount(turnKey) >= config.maxBlocksPerTurn) {
    allow(`block limit for this turn (${config.maxBlocksPerTurn}) reached`);
    return;
  }

  const prompt = buildPrompt({
    changedFiles: meaningful,
    assistantText: turn.assistantText
  });
  const verdict = runReviewer({ cwd, prompt, config });

  if (!verdict.blocked) {
    allow(verdict.note ?? "review passed", {
      files: meaningful,
      costUsd: verdict.costUsd,
      durationMs: verdict.durationMs
    });
    return;
  }

  const count = recordBlock(turnKey);
  const remaining = config.maxBlocksPerTurn - count;
  const footer =
    remaining > 0
      ? "\n\n--- The findings above come from the review gate. Verify them yourself, fix what should be fixed, then finish. If you judge a finding to be wrong, you may finish after stating why."
      : "\n\n--- The findings above come from the review gate. This is the last gate run for this turn.";

  block(`Review gate found problems:\n\n${verdict.reason}${footer}`, {
    files: meaningful,
    costUsd: verdict.costUsd,
    durationMs: verdict.durationMs,
    blockCount: count
  });
}

try {
  main();
} catch (error) {
  // Never let an exception here get in the way of stopping. Leave it on stderr only.
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[review-gate] ${message}\n`);
}
