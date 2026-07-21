# cc-review-gate

A Stop hook that makes a second Claude review the changes right before Claude Code ends its turn.
If the reviewer finds a real problem, the hook blocks the stop and feeds the findings back into the session, which then keeps working and fixes them.

Nobody has to remember to ask for a review. Any session that wrote code passes through one before it is allowed to stop.

```
You: "fix this function"
  -> Claude edits the file and tries to finish
  -> [Stop hook] detects the edits -> spawns a reviewer Claude -> verdict
  -> BLOCK: the session does not stop; it reads the findings and fixes them
  -> ALLOW: the session finishes normally
```

日本語版は [README.ja.md](README.ja.md) にあります。

## Requirements

- Claude Code (the `claude` binary must be on `PATH`)
- Node.js 18 or newer
- macOS or Linux

Verified on Claude Code 2.1.216.
The reviewer is launched with `--effort` and `--tools`, so older versions may not work.

## Install

```bash
git clone https://github.com/tnkshuuhei/cc-review-gate.git
cd cc-review-gate
node install.mjs
```

The installer does four things.

1. Copies `hooks/review-gate/` to `~/.claude/hooks/review-gate/`
2. Copies `commands/gate.md` to `~/.claude/commands/gate.md` (this is what gives you `/gate`)
3. Creates `~/.claude/review-gate/config.json` (left alone if it already exists)
4. Adds one entry to the `Stop` hooks in `~/.claude/settings.json`

`settings.json` is backed up as `settings.json.bak-<timestamp>` before it is touched.
Existing Stop hooks (notifications and the like) are preserved, and re-running the installer when the hook is already registered is a no-op — it is safe to run repeatedly.

To see what would be written without writing it:

```bash
node install.mjs --dry-run
```

Restart any running Claude Code session afterwards. `settings.json` is only read at startup.

### Installing by hand

You can skip the installer and place the files yourself.

```bash
cp -R hooks/review-gate ~/.claude/hooks/
cp commands/gate.md ~/.claude/commands/
```

Then add this to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/review-gate/stop-gate.mjs\"",
            "timeout": 900
          }
        ]
      }
    ]
  }
}
```

`timeout` is the ceiling for the whole hook, in seconds.
Keep it comfortably above the reviewer's own timeout (600s by default).

## Verifying the install

Start Claude Code and type `/gate`. It prints the current state.

```
review-gate: ON / this directory: enabled
  model=opus effort=high timeout=600s
  maxBlocksPerTurn=2
  ...
```

Then have Claude write some code in a throwaway repo.
When it tries to finish, you get a pause of a few dozen seconds while the reviewer runs.
If something is found, Claude does not stop — it starts fixing instead.

Verdict history:

```
/gate log
```

```
2026-07-21T12:32:03.366Z [block] $0.184 47s Review gate found problems: ...
2026-07-21T12:40:11.902Z [allow] $0.092 31s ALLOW: change is consistent with existing callers
```

## Usage

`/gate` takes a subcommand (equivalent to `node ~/.claude/hooks/review-gate/gate.mjs <subcommand>`).

| Command | Effect |
| --- | --- |
| `/gate` | Show state and configuration |
| `/gate off` | Turn the gate off |
| `/gate on` | Turn the gate on |
| `/gate here-off` | Exclude the current directory tree only |
| `/gate here-on` | Remove that exclusion |
| `/gate log 50` | Show the last 50 verdicts |
| `/gate set model sonnet` | Change a configuration value |

## Configuration

Edit `~/.claude/review-gate/config.json` directly, or use `/gate set <key> <value>`.

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master on/off switch |
| `model` | `opus` | Reviewer model |
| `effort` | `high` | Reviewer reasoning effort |
| `timeoutSeconds` | `600` | Reviewer time limit; exceeding it allows the stop |
| `maxBlocksPerTurn` | `2` | How many times a single turn may be blocked |
| `disabledPaths` | `[]` | Absolute paths under which the gate never runs |
| `ignoreGlobs` | see below | If a turn only touched these, skip the review |

`ignoreGlobs` defaults to documentation (`**/*.md`, `**/*.mdx`, `**/*.txt`), lock files, scratchpads and temp directories.
This is what keeps the reviewer from firing on a turn that only edited a README.

If you want to spend less, lowering the model is by far the biggest lever.

```
/gate set model sonnet
/gate set effort medium
```

## When the reviewer actually runs

Not on every turn. There are four skip conditions.

- The previous turn edited no files at all (research, questions, config lookups)
- Every edited file matched `ignoreGlobs`
- The working directory is under `disabledPaths`
- The turn has already been blocked `maxBlocksPerTurn` times

Ordinary conversation and investigation never trigger it, so leaving the gate on all the time barely changes how the tool feels.

Edited files are detected from the `file-history-delta` records Claude Code writes into the transcript.
That is the list of files actually written to disk — not the assistant's own claim about what it did.

## When in doubt, it lets you through

The gate is fail-open, everywhere.
Reviewer crashed, timed out, produced output in an unexpected shape, `claude` not found on `PATH` — every one of those resolves to "allow".

A gate that halts your work because of its own accident damages the experience more than a missed issue does.
For something other people install, keeping a misfire from stopping their work matters more than catching everything.

The reviewer prompt leans the same way: when unsure, ALLOW; to block, it must name the file and line and say how the code breaks and on what input.
One false positive costs a wasted round trip, and that is how people learn to turn a gate off.

## What the reviewer can see

The reviewer runs read-only.
It gets `Read` / `Grep` / `Glob` and read-only git commands (`git diff`, `git status`, `git log`, `git show`, `git rev-parse`, `git blame`) — nothing else.
No write tools are handed to it in the first place, so it cannot "helpfully" edit your code.

MCP servers and skills are disabled for the reviewer (startup tokens drop from 19.4k to 9.1k).
Setting sources are not disabled, so the project's `CLAUDE.md` is still loaded: the reviewer judges with your project's conventions in hand.

The blocking criteria live in `hooks/review-gate/prompts/review.md`.

It blocks on: bugs with a concrete failure path, swallowed errors, security or data-integrity risks, contract violations against the rest of the repo, violations of written project rules, and claims of work that was not actually done.

It does not block on: style, naming, formatting, preference, missing tests, correct-but-different refactors, speculation without an identified failure path, or anything that already existed before this turn.

To change the criteria, edit `~/.claude/hooks/review-gate/prompts/review.md`.
The one contract you must keep is that the first line of the output starts with `ALLOW:` or `BLOCK:` — the verdict is parsed from that line alone.

### Language of the findings

The findings are written in English. That instruction is the last paragraph of `prompts/review.md`; name another language there and nothing else has to change.
The findings are consumed by the other Claude session as its next instruction, so they only have to be readable by whoever also reads `/gate log`.

## Cost

With the defaults (opus + effort high), measured over 20 runs here: median $0.28 / 50s per review, worst case $1.04 / 137s.
It scales pretty much linearly with the size of the change.

Over the same period the hook fired 70 times and the reviewer ran on 20 of them.
The rest were turns with no edits, or documentation-only changes that were skipped.

Your own numbers are in `/gate log`.

## Uninstall

```bash
node uninstall.mjs
```

Removes the hook registration from `settings.json` (after backing it up) and deletes the hook and the `/gate` command.
Configuration and logs under `~/.claude/review-gate/` are kept; add `--purge` to remove those too.

If you only want to pause it, `/gate off` is enough — no need to uninstall.

## Troubleshooting

**The reviewer never runs**

Check `enabled` and whether the directory is excluded with `/gate`.
Then read `/gate log` — the skip reason is recorded there (no code changes in the previous turn, only `ignoreGlobs` matches, and so on).

**The log says the `claude` executable could not be found**

Hooks are launched without going through a login shell, so `claude` is not found unless it sits in a standard `PATH` location.
Set the full path in `CLAUDE_REVIEW_GATE_BIN`:

```json
{
  "env": {
    "CLAUDE_REVIEW_GATE_BIN": "/Users/you/.local/bin/claude"
  }
}
```

**It blocks every time and the turn never ends**

`maxBlocksPerTurn` (2 by default) cuts it off, so it cannot loop forever.
If it is still annoying, exclude that project with `/gate here-off`.

**A config change had no effect**

`config.json` is re-read on every run, so no restart is needed.
Only `settings.json` changes require restarting Claude Code.

## Layout

```
hooks/review-gate/
  stop-gate.mjs        The Stop hook: decides whether to run, returns the block
  gate.mjs             The /gate implementation: config read/write, log display
  lib/config.mjs       Persistence for config, block counts, logs
  lib/transcript.mjs   Reads the transcript for files changed in the last turn
  lib/reviewer.mjs     Spawns the reviewer Claude, parses the verdict
  prompts/review.md    Reviewer instructions; the blocking criteria live here
commands/gate.md       The /gate slash command definition
install.mjs            Installer
uninstall.mjs          Uninstaller
```

No dependencies. Node standard library only.

## Implementation notes

The reviewer is itself a `claude` process, so its exit fires the Stop hook again.
Left alone that nests forever, so the reviewer is spawned with `CLAUDE_REVIEW_GATE_ACTIVE=1` and the hook bails out on that variable as its very first step.

Blocking the same turn indefinitely would mean the round trips never end, so blocks are counted per `session_id` plus the turn-boundary uuid and cut off at the limit.
The last 100 records are kept in `~/.claude/review-gate/state.json`.

## License

MIT
