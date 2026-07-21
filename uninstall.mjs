#!/usr/bin/env node
// cc-review-gate のアンインストーラ。
//   node uninstall.mjs [--purge] [--dry-run]
//
// settings.json から Stop フックの登録を外し、フック本体と /gate コマンドを消す。
// 設定・ログ (~/.claude/review-gate/) は既定で残す。--purge で消す。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");

const DRY_RUN = process.argv.includes("--dry-run");
const PURGE = process.argv.includes("--purge");

function log(message) {
  console.log(message);
}

function removeFromSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) {
    log("settings.json がありません（スキップ）");
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    log(`⚠️  ${SETTINGS_PATH} が読めませんでした。Stop フックの行は手動で消してください。`);
    return;
  }

  const stopGroups = settings?.hooks?.Stop;
  if (!Array.isArray(stopGroups)) {
    log("Stop フックの登録はありませんでした");
    return;
  }

  let removed = 0;
  for (const group of stopGroups) {
    if (!Array.isArray(group?.hooks)) continue;
    const before = group.hooks.length;
    group.hooks = group.hooks.filter(
      (hook) => !String(hook?.command ?? "").includes("review-gate/stop-gate.mjs")
    );
    removed += before - group.hooks.length;
  }
  // 空になったグループは残さない。
  settings.hooks.Stop = stopGroups.filter((group) => (group?.hooks ?? []).length > 0);
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (removed === 0) {
    log("Stop フックの登録はありませんでした");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (!DRY_RUN) {
    fs.copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak-${stamp}`);
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  }
  log(`✓ settings.json から ${removed} 件のフック登録を削除しました（バックアップ: ${SETTINGS_PATH}.bak-${stamp}）`);
}

function removeFiles() {
  const hookDir = path.join(CLAUDE_DIR, "hooks", "review-gate");
  if (fs.existsSync(hookDir)) {
    if (!DRY_RUN) fs.rmSync(hookDir, { recursive: true, force: true });
    log(`✓ 削除: ${hookDir}`);
  }

  const commandPath = path.join(CLAUDE_DIR, "commands", "gate.md");
  if (fs.existsSync(commandPath)) {
    if (!DRY_RUN) fs.rmSync(commandPath, { force: true });
    log(`✓ 削除: ${commandPath}`);
  }

  const stateDir = path.join(CLAUDE_DIR, "review-gate");
  if (!fs.existsSync(stateDir)) return;
  if (PURGE) {
    if (!DRY_RUN) fs.rmSync(stateDir, { recursive: true, force: true });
    log(`✓ 削除: ${stateDir}`);
  } else {
    log(`- 設定とログは残しました: ${stateDir} (消すなら --purge)`);
  }
}

log(DRY_RUN ? "cc-review-gate をアンインストールします (--dry-run)\n" : "cc-review-gate をアンインストールします\n");
removeFromSettings();
removeFiles();
log("\n完了しました。起動中の Claude Code は再起動してください。");
