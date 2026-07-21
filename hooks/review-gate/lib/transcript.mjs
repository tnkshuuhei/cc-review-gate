// transcript (JSONL) を読んで「直前のターンで何が起きたか」を取り出す。
//
// Claude Code は編集したファイルを file-history-delta エントリに
// trackingPath + timestamp で記録している。これを直前ターンの境界時刻で
// 絞り込めば、実際に触ったファイルが推測ではなく事実として得られる。

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
      // 書き込み途中の行などは黙って捨てる。
    }
  }
  return entries;
}

// 人間が実際に送ったプロンプト（= ターンの始まり）かどうか。
// tool_result の差し戻しやフック由来のメタメッセージは境界にしない。
function isTurnBoundary(entry) {
  if (entry?.type !== "user") return false;
  if (entry.isSidechain === true) return false;
  if (entry.isMeta === true) return false;
  if (entry.isCompactSummary === true) return false;

  const content = entry.message?.content;
  if (typeof content === "string") {
    const text = content.trim();
    if (!text) return false;
    // スラッシュコマンドの実行結果そのものは境界ではない。
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

// "**/*.md" 程度の簡易 glob。依存を増やさないための最小実装。
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // "**/" はディレクトリ 0 段以上にマッチさせる。
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
 * 直前ターンの要約を返す。
 * - boundaryUuid: ターン開始となったユーザーメッセージの uuid（重複ブロック抑止のキー）
 * - changedFiles: そのターン中に編集されたファイル（リポジトリ相対）
 * - editToolCalls: 編集系ツールの呼び出し回数（changedFiles が取れないときの保険）
 * - assistantText: 直前ターンでアシスタントが書いた本文
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
      // timestamp で絞るので、snapshot が作られていないターンでも取りこぼさない。
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
    // サブエージェントの独り言は本体の成果報告ではないので本文には混ぜない。
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
