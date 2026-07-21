#!/usr/bin/env node
// Installer for cc-review-gate.
//   node install.mjs [--dry-run]
//
// What it does:
//   1. Copy hooks/review-gate/ to ~/.claude/hooks/review-gate/
//   2. Copy commands/gate.md to ~/.claude/commands/gate.md
//   3. Create ~/.claude/review-gate/config.json (only if it does not exist)
//   4. Add one entry to the Stop hooks in ~/.claude/settings.json
//
// settings.json is always backed up before being rewritten, and if the same hook is
// already registered nothing happens at all — running this repeatedly is safe.

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
  console.error(`Error: ${message}`);
  process.exit(1);
}

// Do not write when the content is identical. When something different is already
// there, leave a .bak behind before overwriting.
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
    fail(`Node.js 18 or newer is required (found: v${process.versions.node})`);
  }

  const found = spawnSync("sh", ["-lc", "command -v claude"], { encoding: "utf8" });
  const claudeBin = String(found.stdout ?? "").trim();
  if (!claudeBin) {
    log("⚠️  The claude command was not found on PATH.");
    log("    The reviewer is launched through claude itself, so install Claude Code first.");
    log("    (If it lives somewhere off PATH, point CLAUDE_REVIEW_GATE_BIN at it.)");
  } else {
    log(`✓ claude: ${claudeBin}`);
  }
}

function copyFiles() {
  const src = path.join(REPO_DIR, "hooks", "review-gate");
  const dest = path.join(CLAUDE_DIR, "hooks", "review-gate");
  if (!fs.existsSync(src)) fail(`Source directory not found: ${src}`);

  if (fs.existsSync(dest)) {
    log(`  Overwriting the existing ${dest} (config and logs live elsewhere and survive)`);
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(src, dest, { recursive: true });
  }
  log(`✓ Hook: ${dest}`);

  const commandSrc = path.join(REPO_DIR, "commands", "gate.md");
  const commandDest = path.join(CLAUDE_DIR, "commands", "gate.md");
  if (fs.existsSync(commandDest)) {
    const same = fs.readFileSync(commandDest, "utf8") === fs.readFileSync(commandSrc, "utf8");
    if (!same) {
      const backup = backupIfExists(commandDest);
      log(`  Existing /gate command saved as: ${backup}`);
    }
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(commandDest), { recursive: true });
    fs.copyFileSync(commandSrc, commandDest);
  }
  log(`✓ Slash command: ${commandDest} (/gate)`);
}

function createConfig() {
  const configPath = path.join(CLAUDE_DIR, "review-gate", "config.json");
  if (fs.existsSync(configPath)) {
    log(`✓ Config already exists and is left untouched: ${configPath}`);
    return;
  }
  if (!DRY_RUN) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);
  }
  log(`✓ Config created: ${configPath}`);
}

function patchSettings() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    } catch {
      fail(`${SETTINGS_PATH} is not readable as JSON. Fix it by hand, then run this again.`);
    }
  }

  settings.hooks ??= {};
  settings.hooks.Stop ??= [];
  const stopGroups = settings.hooks.Stop;

  const alreadyInstalled = stopGroups.some((group) =>
    (group?.hooks ?? []).some((hook) => String(hook?.command ?? "").includes("review-gate/stop-gate.mjs"))
  );
  if (alreadyInstalled) {
    log("✓ Already registered in settings.json (no change)");
    return;
  }

  // Append to an existing empty-matcher group when there is one, so other Stop hooks
  // (notifications and the like) are left intact.
  const entry = { type: "command", command: HOOK_COMMAND, timeout: HOOK_TIMEOUT };
  const target = stopGroups.find((group) => (group?.matcher ?? "") === "");
  if (target) {
    target.hooks ??= [];
    target.hooks.unshift(entry);
  } else {
    stopGroups.push({ matcher: "", hooks: [entry] });
  }

  const backup = backupIfExists(SETTINGS_PATH);
  if (backup) log(`  settings.json backed up as: ${backup}`);
  if (!DRY_RUN) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  }
  log(`✓ Stop hook registered in: ${SETTINGS_PATH}`);
}

log(DRY_RUN ? "Installing cc-review-gate (--dry-run: nothing is written)\n" : "Installing cc-review-gate\n");
checkPrerequisites();
copyFiles();
createConfig();
patchSettings();

log(`
Done.

Next:
  1. Restart any running Claude Code (settings.json is only read at startup)
  2. Check the state with /gate
  3. Have it write some code and watch the review run as it tries to finish

  Log:       node ~/.claude/hooks/review-gate/gate.mjs log
  Pause:     node ~/.claude/hooks/review-gate/gate.mjs off
  Uninstall: node ${path.join(REPO_DIR, "uninstall.mjs")}
`);
