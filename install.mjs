#!/usr/bin/env node
// cc-review-gate のインストーラ。
//   node install.mjs [--dry-run]
//
// やること:
//   1. hooks/review-gate/ を ~/.claude/hooks/review-gate/ にコピー
//   2. commands/gate.md を ~/.claude/commands/gate.md にコピー
//   3. ~/.claude/review-gate/config.json を（無ければ）作成
//   4. ~/.claude/settings.json の Stop フックに 1 行追加
//
// settings.json は書き換える前に必ずバックアップを取り、
// すでに同じフックが登録されていれば何もしない（何度実行しても安全）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO_DIR = path.dirname(fileURLToPath(import.meta.url));
const CLAUDE_DIR = path.join(os.homedir(), ".claude");
const SETTINGS_PATH = path.join(CLAUDE_DIR, "settings.json");
const HOOK_COMMAND = 'node "$HOME/.claude/hooks/review-gate/stop-gate.mjs"';
const HOOK_TIMEOUT = 900;

const DRY_RUN = process.argv.includes("--dry-run");

const DEFAULT_CONFIG = {
  enabled: true,
  model: "opus",
  effort: "high",
  timeoutSeconds: 600,
  maxBlocksPerTurn: 2,
  disabledPaths: [],
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

function log(message) {
  console.log(message);
}

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(1);
}

// 同じ内容なら書かない。違う内容が既にあれば .bak を残してから上書きする。
function backupIfExists(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${filePath}.bak-${stamp}`;
  if (!DRY_RUN) fs.copyFileSync(filePath, backup);
  return backup;
}

function checkPrerequisites() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 18) {
    fail(`Node.js 18 以上が必要です (現在: v${process.versions.node})`);
  }

  const found = spawnSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" });
  const claudeBin = String(found.stdout ?? "").trim();
  if (!claudeBin) {
    log("⚠️  claude コマンドが PATH に見つかりませんでした。");
    log("    レビュアの起動に claude 本体が必要です。Claude Code をインストールしてから使ってください。");
    log("    (PATH に無い場所にある場合は CLAUDE_REVIEW_GATE_BIN 環境変数で指定できます)");
  } else {
    log(`✓ claude: ${claudeBin}`);
  }
}

function copyFiles() {
  const src = path.join(REPO_DIR, "hooks", "review-gate");
  const dest = path.join(CLAUDE_DIR, "hooks", "review-gate");
  if (!fs.existsSync(src)) fail(`コピー元が見つかりません: ${src}`);

  if (fs.existsSync(dest)) {
    log(`  既存の ${dest} を上書きします（設定とログは別ディレクトリなので消えません）`);
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  log(`✓ フック本体: ${dest}`);

  const commandSrc = path.join(REPO_DIR, "commands", "gate.md");
  const commandDest = path.join(CLAUDE_DIR, "commands", "gate.md");
  if (fs.existsSync(commandDest)) {
    const same = fs.readFileSync(commandDest, "utf8") === fs.readFileSync(commandSrc, "utf8");
    if (!same) {
      const backup = backupIfExists(commandDest);
      log(`  既存の /gate コマンドを退避しました: ${backup}`);
    }
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(commandDest), { recursive: true });
    fs.copyFileSync(commandSrc, commandDest);
  }
  log(`✓ スラッシュコマンド: ${commandDest} (/gate)`);
}

function createConfig() {
  const configPath = path.join(CLAUDE_DIR, "review-gate", "config.json");
  if (fs.existsSync(configPath)) {
    log(`✓ 設定は既にあります（保持します）: ${configPath}`);
    return;
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
  log(`✓ 設定を作成しました: ${configPath}`);
}

function patchSettings() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    } catch {
      fail(`${SETTINGS_PATH} が JSON として読めません。手動で直してから再実行してください。`);
    }
  }

  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  const stopGroups = settings.hooks.Stop;

  const alreadyInstalled = stopGroups.some((group) =>
    (group?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes("review-gate/stop-gate.mjs"))
  );
  if (alreadyInstalled) {
    log("✓ settings.json には既に登録済みでした（変更なし）");
    return;
  }

  // 既存の通知フックなどを壊さないよう、matcher が空のグループがあればそこに足す。
  const entry = { type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT };
  const target = stopGroups.find((group) => (group?.matcher ?? "") === "");
  if (target) {
    target.hooks ??= [];
    target.hooks.unshift(entry);
  } else {
    stopGroups.push({ matcher: "", hooks: [entry] });
  }

  const backup = backupIfExists(SETTINGS_PATH);
  if (backup) log(`  settings.json をバックアップしました: ${backup}`);
  if (!DRY_RUN) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  }
  log(`✓ Stop フックを登録しました: ${SETTINGS_PATH}`);
}

log(DRY_RUN ? "cc-review-gate をインストールします (--dry-run: 書き込みません)\n" : "cc-review-gate をインストールします\n");
checkPrerequisites();
copyFiles();
createConfig();
patchSettings();

log(`
完了しました。

次にやること:
  1. 起動中の Claude Code があれば再起動する（settings.json は起動時に読まれます）
  2. /gate で状態を確認する
  3. 何かコードを書かせて、終了時にレビューが走るのを見る

  ログ:   node ~/.claude/hooks/review-gate/gate.mjs log
  一時停止: node ~/.claude/hooks/review-gate/gate.mjs off
  アンインストール: node ${path.join(REPO_DIR, "uninstall.mjs")}
`);
