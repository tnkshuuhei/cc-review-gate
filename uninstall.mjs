#!/usr/bin/env node
// Uninstaller for cc-review-gate.
//   node uninstall.mjs [--purge] [--dry-run]
//
// Removes the Stop hook registration from settings.json and deletes the hook and the
// /gate command. Config and logs (~/.claude/review-gate/) are kept by default; --purge
// removes those too.

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
    log("No settings.json (skipped)");
    return;
  }

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
  } catch {
    log(`⚠️  Could not read ${SETTINGS_PATH}. Remove the Stop hook entry by hand.`);
    return;
  }

  const stopGroups = settings?.hooks?.Stop;
  if (!Array.isArray(stopGroups)) {
    log("No Stop hook registration found");
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
  // Do not leave empty groups behind.
  settings.hooks.Stop = stopGroups.filter((group) => (group?.hooks ?? []).length > 0);
  if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

  if (removed === 0) {
    log("No Stop hook registration found");
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  if (!DRY_RUN) {
    fs.copyFileSync(SETTINGS_PATH, `${SETTINGS_PATH}.bak-${stamp}`);
    fs.writeFileSync(SETTINGS_PATH, `${JSON.stringify(settings, null, 2)}\n`);
  }
  log(`✓ Removed ${removed} hook registration(s) from settings.json (backup: ${SETTINGS_PATH}.bak-${stamp})`);
}

function removeFiles() {
  const hookDir = path.join(CLAUDE_DIR, "hooks", "review-gate");
  if (fs.existsSync(hookDir)) {
    if (!DRY_RUN) fs.rmSync(hookDir, { recursive: true, force: true });
    log(`✓ Removed: ${hookDir}`);
  }

  const commandPath = path.join(CLAUDE_DIR, "commands", "gate.md");
  if (fs.existsSync(commandPath)) {
    if (!DRY_RUN) fs.rmSync(commandPath, { force: true });
    log(`✓ Removed: ${commandPath}`);
  }

  const stateDir = path.join(CLAUDE_DIR, "review-gate");
  if (!fs.existsSync(stateDir)) return;
  if (PURGE) {
    if (!DRY_RUN) fs.rmSync(stateDir, { recursive: true, force: true });
    log(`✓ Removed: ${stateDir}`);
  } else {
    log(`- Config and logs kept: ${stateDir} (use --purge to remove them)`);
  }
}

log(DRY_RUN ? "Uninstalling cc-review-gate (--dry-run)\n" : "Uninstalling cc-review-gate\n");
removeFromSettings();
removeFiles();
log("\nDone. Restart any running Claude Code.");
