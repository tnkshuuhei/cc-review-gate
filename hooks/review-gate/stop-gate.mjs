#!/usr/bin/env node
// Stop フック本体。
//
// 直前ターンでコード変更があった場合だけ、読み取り専用の claude を別プロセスで立ち上げて
// レビューさせる。BLOCK 判定なら {"decision":"block"} を返し、Claude を停止させずに
// 修正を続けさせる。
//
// 判定できないとき（レビュア異常終了、タイムアウト、形式不正）は常に通す。
// ゲート自身の事故で作業が止まる方が、見落としより体験を壊すため。

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
  // 再帰ガード: レビュア側の claude が停止したときに、この処理を再び走らせない。
  if (process.env[GUARD_ENV] === "1") return;

  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const config = loadConfig();

  if (!config.enabled) return;
  if (isPathDisabled(config, cwd)) return;

  const turn = analyzeLastTurn(input.transcript_path);

  // 変更がないターン（調査・報告・設定確認だけ）はレビュアを起動しない。
  // これが効くのでゲートを常時 ON にしても日常の体感が変わらない。
  if (turn.changedFiles.length === 0 && turn.editToolCalls === 0) {
    allow("直前ターンにコード変更なし");
    return;
  }

  const meaningful = turn.changedFiles.filter(
    (file) => !matchesAnyGlob(file, config.ignoreGlobs)
  );
  if (turn.changedFiles.length > 0 && meaningful.length === 0) {
    allow("変更が ignoreGlobs のみ", { files: turn.changedFiles });
    return;
  }

  // 同じターンを何度もブロックし続けると往復が終わらないので上限で打ち切る。
  const turnKey = `${input.session_id ?? "unknown"}:${turn.boundaryUuid ?? "unknown"}`;
  if (getBlockCount(turnKey) >= config.maxBlocksPerTurn) {
    allow(`同一ターンのブロック上限 (${config.maxBlocksPerTurn}) に到達`);
    return;
  }

  const prompt = buildPrompt({
    changedFiles: meaningful,
    assistantText: turn.assistantText
  });
  const verdict = runReviewer({ cwd, prompt, config });

  if (!verdict.blocked) {
    allow(verdict.note ?? "レビュー通過", {
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
      ? "\n\n--- 上記はレビューゲートの指摘です。妥当かを自分で確かめ、直すべきものを直してから終了してください。指摘が誤りだと判断した場合は、その根拠を述べて終了して構いません。"
      : "\n\n--- 上記はレビューゲートの指摘です。これがこのターン最後のゲート実行です。";

  block(`レビューゲートが問題を検出しました:\n\n${verdict.reason}${footer}`, {
    files: meaningful,
    costUsd: verdict.costUsd,
    durationMs: verdict.durationMs,
    blockCount: count
  });
}

try {
  main();
} catch (error) {
  // 例外時も停止を邪魔しない。stderr にだけ残す。
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[review-gate] ${message}\n`);
}
