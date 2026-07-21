---
description: Inspect, toggle and audit the review gate (Stop hook)
argument-hint: "[status|on|off|here-off|here-on|log [n]|set <key> <value>]"
allowed-tools: Bash(node:*)
---

Current state of the review gate:

!`node "$HOME/.claude/hooks/review-gate/gate.mjs" $ARGUMENTS`

Report the output above to the user concisely. If they asked for a configuration change, confirm that it took effect and say so.
