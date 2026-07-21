// Reading the transcript (JSONL) to work out what happened during the previous turn.
//
// Claude Code records every edited file as a file-history-delta entry carrying
// trackingPath + timestamp. Filtering those by the previous turn's boundary time gives
// the files that were actually touched as fact, not as a guess.

import fs from "node:fs";

const EDIT_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

function parseLines(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      // Silently drop half-written lines and the like.
    }
  }
  return entries;
}

// Whether this is a prompt a human actually sent (i.e. the start of a turn).
// Returned tool_results and hook-generated meta messages are not boundaries.
function isTurnBoundary(entry) {
  if (entry?.type !== "user") return false;
  if (entry.isSidechain === true) return false;
  if (entry.isMeta === true) return false;
  if (entry.isCompactSummary === true) return false;

  const content = entry.message?.content;
  if (typeof content === "string") {
    const text = content.trim();
    if (!text) return false;
    // The output of a slash command is not itself a boundary.
    if (text.startsWith("<local-command-stdout>")) return false;
    if (text.startsWith("<local-command-caveat>")) return false;
    return true;
  }
  if (Array.isArray(content)) {
    return content.some((block) => block?.type === "text");
  }
  return false;
}

function textFromAssistant(entry) {
  const content = entry.message?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

// A minimal glob, enough for patterns like "**/*.md". Kept small to avoid a dependency.
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" matches zero or more directory levels.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

export function matchesAnyGlob(filePath, patterns = []) {
  return patterns.some((pattern) => globToRegExp(pattern).test(filePath));
}

/**
 * Summarize the previous turn.
 * - boundaryUuid: uuid of the user message that started the turn (the key used to cap repeat blocks)
 * - changedFiles: files edited during that turn (repository-relative)
 * - editToolCalls: number of edit-tool calls, as a fallback when changedFiles comes back empty
 * - assistantText: the prose the assistant wrote during the previous turn
 */
export function analyzeLastTurn(transcriptPath) {
  const empty = {
    boundaryUuid: null,
    changedFiles: [],
    editToolCalls: 0,
    assistantText: ""
  };
  if (!transcriptPath) return empty;

  const entries = parseLines(transcriptPath);
  if (entries.length === 0) return empty;

  let boundaryIndex = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isTurnBoundary(entries[i])) {
      boundaryIndex = i;
      break;
    }
  }
  if (boundaryIndex === -1) return empty;

  const boundary = entries[boundaryIndex];
  const boundaryTime = boundary.timestamp ?? "";

  const changedFiles = new Set();
  let editToolCalls = 0;
  const assistantTexts = [];

  for (let i = boundaryIndex + 1; i < entries.length; i += 1) {
    const entry = entries[i];

    if (entry.type === "file-history-delta") {
      // Filtering by timestamp means nothing is missed on turns where no snapshot was taken.
      if (!boundaryTime || String(entry.timestamp ?? "") >= boundaryTime) {
        if (entry.trackingPath) changedFiles.add(entry.trackingPath);
      }
      continue;
    }

    if (entry.type !== "assistant") continue;

    for (const block of entry.message?.content ?? []) {
      if (block?.type === "tool_use" && EDIT_TOOLS.has(block.name)) {
        editToolCalls += 1;
      }
    }
    // A subagent talking to itself is not the main session reporting its work, so keep it out.
    if (entry.isSidechain !== true) {
      const text = textFromAssistant(entry);
      if (text) assistantTexts.push(text);
    }
  }

  return {
    boundaryUuid: boundary.uuid ?? null,
    changedFiles: [...changedFiles].sort(),
    editToolCalls,
    assistantText: assistantTexts.join("\n\n").trim()
  };
}
