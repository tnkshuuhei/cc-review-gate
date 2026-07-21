#!/usr/bin/env node
// Management CLI for the review gate.
//   node gate.mjs status | on | off | here-off | here-on | set <key> <value> | log [n]

import fs from "node:fs";
import process from "node:process";

import { loadConfig, saveConfig, isPathDisabled, CONFIG_PATH, LOG_PATH } from "./lib/config.mjs";

const [command = "status", ...rest] = process.argv.slice(2);
const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function printStatus() {
  const config = loadConfig();
  const here = isPathDisabled(config, cwd) ? "disabled (path excluded)" : "enabled";
  console.log(`review-gate: ${config.enabled ? "ON" : "OFF"} / this directory: ${here}`);
  console.log(`  model=${config.model} effort=${config.effort} timeout=${config.timeoutSeconds}s`);
  console.log(`  maxBlocksPerTurn=${config.maxBlocksPerTurn}`);
  console.log(`  ignoreGlobs=${config.ignoreGlobs.join(", ")}`);
  if (config.disabledPaths.length > 0) {
    console.log(`  disabledPaths=\n    ${config.disabledPaths.join("\n    ")}`);
  }
  console.log(`  config: ${CONFIG_PATH}`);
}

function printLog(count) {
  let raw;
  try {
    raw = fs.readFileSync(LOG_PATH, "utf8");
  } catch {
    console.log("No log entries yet.");
    return;
  }
  const lines = raw.trim().split("\n").filter(Boolean).slice(-count);
  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      const cost = record.costUsd ? ` $${record.costUsd.toFixed(3)}` : "";
      const secs = record.durationMs ? ` ${Math.round(record.durationMs / 1000)}s` : "";
      console.log(`${record.at} [${record.decision}]${cost}${secs} ${record.reason ?? ""}`);
    } catch {
      // Skip corrupted lines.
    }
  }
}

switch (command) {
  case "on":
    saveConfig({ enabled: true });
    printStatus();
    break;

  case "off":
    saveConfig({ enabled: false });
    printStatus();
    break;

  case "here-off": {
    const config = loadConfig();
    if (!config.disabledPaths.includes(cwd)) {
      saveConfig({ disabledPaths: [...config.disabledPaths, cwd] });
    }
    printStatus();
    break;
  }

  case "here-on": {
    const config = loadConfig();
    saveConfig({ disabledPaths: config.disabledPaths.filter((dir) => dir !== cwd) });
    printStatus();
    break;
  }

  case "set": {
    const [key, ...valueParts] = rest;
    const rawValue = valueParts.join(" ");
    if (!key || !rawValue) {
      console.error("usage: set <key> <value>");
      process.exitCode = 1;
      break;
    }
    // Interpret numbers, booleans and comma-separated arrays at face value.
    let value = rawValue;
    if (/^\d+$/.test(rawValue)) value = Number(rawValue);
    else if (rawValue === "true" || rawValue === "false") value = rawValue === "true";
    else if (rawValue.includes(",")) value = rawValue.split(",").map((s) => s.trim());
    saveConfig({ [key]: value });
    printStatus();
    break;
  }

  case "log":
    printLog(Number(rest[0]) || 20);
    break;

  default:
    printStatus();
}
