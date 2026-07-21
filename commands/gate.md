---
description: レビューゲート (Stop hook) の状態確認・ON/OFF・履歴
argument-hint: "[status|on|off|here-off|here-on|log [n]|set <key> <value>]"
allowed-tools: Bash(node:*)
---

レビューゲートの現在の状態:

!`node "$HOME/.claude/hooks/review-gate/gate.mjs" $ARGUMENTS`

上の出力をユーザーに日本語で簡潔に報告して。設定変更を求められていた場合は、それが反映されているかを確認して伝えること。
