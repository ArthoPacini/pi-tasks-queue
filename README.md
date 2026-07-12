# pi-codex-goal

Codex-style goal tracking for pi.

This package adds a `/goal` command plus three model-callable tools:

- `get_goal`
- `create_goal`
- `update_goal`

Goal state is stored in pi session custom entries, so it follows session history, resume, fork, tree navigation, reload, and compaction behavior without an external database.

## Install

Install from npm:

```sh
pi install npm:pi-codex-goal
```

Install a pinned npm version:

```sh
pi install npm:pi-codex-goal@<version>
```

Install from GitHub:

```sh
pi install https://github.com/fitchmultz/pi-codex-goal
```

Install a pinned GitHub release:

```sh
pi install https://github.com/fitchmultz/pi-codex-goal@v<version>
```

For local development from this repository, install the checkout only in one Pi config scope at a time:

```sh
npm install
pi install .
```

On this maintainer machine, the active install is a global/user package that already points at this checkout; do not also leave a project-local install under this repository's `.pi/` settings. Duplicate local and global installs both try to register `get_goal`, `create_goal`, and `update_goal`, which causes tool-registration conflicts. For install-path release checks, use an isolated temp project/config directory or remove the project-local entry immediately after the check.

Compatibility note: this package is tested against the current pi release during each package update. The current source tree targets Pi 0.80.6 on Node 24 for the next package release. The latest published npm artifact remains the reproducible source of truth for its own published version's metadata. Pi-bundled runtime packages remain optional wildcard peers, so npm peer ranges do not hard-block users from trying newer pi releases; runtime behavior is only verified against the tested baseline until a follow-up package release confirms it.

Release note: npm installs and pinned GitHub tags are the reproducible release artifacts. Installing from the repository default branch can include unreleased changes that will ship in a future package release, even when `package.json` still identifies the latest published version.

## Best way to create goals

Use the included `/create-goal` prompt template instead of writing a goal by hand. Agents write better goal completion contracts than humans do because they can expand a plain task into outcome, verification, constraints, iteration, audit, and blocked-stop requirements before calling the `create_goal` tool.

```text
/create-goal insert task and requirements here
```

The template follows the Codex goal-writing practices from:

- <https://developers.openai.com/codex/use-cases/follow-goals>
- <https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex>

## Development

Validate types and tests before committing or opening a PR:

```sh
npm run verify
```

GitHub Actions runs this same ordinary hosted CI gate on Node 24 for `push` and `pull_request`. It does not run the Crabbox platform matrix.

Cross-platform release-sensitive changes should also pass the local Crabbox platform smoke gate:

```sh
npm run check:platform-smoke
npm run smoke:platform:all
```

`smoke:platform:all` runs the doctor before any target suite.

That local gate runs `npm run verify`, packs the package, installs the packed package into a clean pi project, checks `pi list`, and runs a real model-backed goal-tool smoke on macOS, Ubuntu Linux, and native Windows. Pi 0.79+ project trust is handled explicitly with `--approve` inside the isolated smoke projects so project-local package settings and the packed extension load in non-interactive runs. The runtime smoke defaults to `zai/glm-5.2`; override it with `PLATFORM_SMOKE_MODEL` and configure forwarded auth env vars with `PLATFORM_SMOKE_AUTH_ENV`. Setup and artifact details: [docs/platform-smoke.md](docs/platform-smoke.md).

Project agent notes and module map: [AGENTS.md](AGENTS.md).
Current structural audit and remediation record: [docs/CODEBASE_AUDIT.md](docs/CODEBASE_AUDIT.md).

## Interactive smoke tests

These smoke tests exercise the interactive `/goal` command, hidden continuation, bridged goal tools, filesystem verification, and final `update_goal` completion.

Release-sensitive changes that touch slash-command parsing, TUI submission, goal command behavior, hidden continuation, or post-tool completion must record manual interactive `/goal` evidence before release. The model-backed platform smoke covers goal tools through non-interactive `pi -p`; it intentionally does not prove the real TUI slash-command submit path. Required evidence is: command used, model, session directory, final assistant evidence, and confirmation that the session JSONL contains the `/goal` command path, file verification, and `update_goal` completion.

Prerequisites:

- Pi can authenticate to any capable model available in your local setup.

Start pi from this repository:

```sh
rm -f /tmp/pi-codex-goal-fast.txt /tmp/pi-codex-goal-slash-smoke.txt
rm -rf /tmp/pi-codex-goal-slash-smoke-session
pi --model <model-id> \
  --session-dir /tmp/pi-codex-goal-slash-smoke-session
```

### Fast manual smoke

Paste this first when you want the shortest interactive confidence check. This intentionally uses shell `cat`; use the full smoke or platform smoke when you need built-in `read` tool coverage:

```text
/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.
```

Expected final evidence:

```text
Verified file path: /tmp/pi-codex-goal-fast.txt
Verified content: PI_GOAL_FAST_OK
Final goal status: complete
```

### Full manual smoke

Paste this when you want the fuller end-to-end path:

```text
/goal Create /tmp/pi-codex-goal-slash-smoke.txt containing PI_GOAL_SLASH_OK, verify the file content from the filesystem, inspect the current goal, and mark the goal complete only after verification. Final reply must include the verified file path, verified content, and final goal status.
```

Expected final evidence:

```text
Verified file path: /tmp/pi-codex-goal-slash-smoke.txt
Verified content: PI_GOAL_SLASH_OK
Final goal status: complete
```

`/goal` is an interactive editor command. Do not use `pi -p '/goal ...'` as a slash-command smoke path; print mode sends an initial model prompt and is not a reliable way to exercise this extension command. For headless automation, prompt the model to call the `create_goal`, `get_goal`, and `update_goal` tools instead of relying on slash-command parsing.

For tmux-driven interactive smoke automation, send the prompt as literal text and submit with CSI-u Enter (`ESC [ 13 u`). Normal `tmux send-keys Enter` works in many setups, but CSI-u is the robust scripted submit path through Pi's TUI key parser. This fast example intentionally uses shell `cat`; change the prompt to require the built-in `read` tool when that path is under test:

```sh
tmux send-keys -t "$TMUX_SESSION" -l '/goal Create /tmp/pi-codex-goal-fast.txt containing PI_GOAL_FAST_OK; verify with cat; mark complete; report final status.'
tmux send-keys -t "$TMUX_SESSION" -l $'\033[13u'
```

If an interactive run appears stuck on `Working...` after a built-in `read` tool result, capture the session JSONL and TUI pane before retrying. A healthy read-verification path includes a `toolName: "read"` tool result, an `update_goal` tool result with `status: "complete"`, and a final assistant message. The package's model-backed platform smoke now asserts that the built-in `read` tool was used; if only the TUI path stalls, treat it as a Pi host/tool-resume repro rather than changing goal continuation logic without more evidence.

## User Commands

```text
/create-goal Build the requested feature and verify it end to end
/goal
/goal Build the requested feature and verify it end to end
/goal pause
/goal resume
/goal resume cancel
/goal copy
/goal clear
```

`/create-goal <task>` is the recommended way to start a goal. It expands the task into a strict objective and asks the model to call the `create_goal` tool with explicit replacement enabled, so you do not need to run `/goal clear` before setting a new goal.

`/goal` with no arguments reports the current objective, status, token budget, token usage, and elapsed active time. A plain `/goal <objective>` starts a new goal or replaces the current one after confirmation. `/goal copy` copies the current goal objective to the system clipboard, including active, paused, budget-limited, and completed goals.

This intentionally matches Codex TUI behavior: token budgets are set through the model tool rather than parsed from `/goal --tokens`. This package keeps its objective size limit at 8000 Unicode characters.

## Model Tools

`create_goal` starts a goal with an objective and optional positive token budget. It fails if a non-complete goal already exists unless `replace_existing: true` is provided. After a goal is complete, `create_goal` replaces it with a new active goal.

`get_goal` returns the current goal state and usage.

`update_goal` only accepts `status: "complete"`, matching Codex's model-side contract. Calling it on an already-complete goal is idempotent and does not append duplicate session entries. The extension reports final token and elapsed-time usage before marking the goal complete.

Completed goals are terminal for automatic transitions: pause, resume, and hidden continuations do not reopen them. To recover from premature completion, use `/goal <objective>` to replace the goal, call `create_goal` with `replace_existing: true`, or `/goal clear` before starting again.

In bridged MCP environments, pi may expose these tools under namespaced MCP names like `pi__get_goal`, `pi__create_goal`, and `pi__update_goal`. Prompt guidance tells models to call whichever goal-tool name is actually exposed in the current run, not display or transcript labels.

## Behavior

While a goal is active, the extension:

- tracks elapsed active time between turns and tool completions
- adds completed assistant turn input plus output token usage when the active model reports it
- coalesces runtime goal custom-entry writes so unchanged status and usage are not appended on every tool completion; live footer usage stays current, and meaningful usage is flushed at turn boundaries, shutdown, compaction, budget crossings, and bounded intervals during long tool-heavy runs
- pauses when an active assistant turn is aborted, such as when you press Esc
- recovers from provider assistant errors without immediate hidden continuation loops: context-window overflow triggers automatic compaction and then resumes the active goal, transient errors use bounded backoff retries, and recognized provider usage-limit pauses schedule a conservative auto-resume retry; use `/goal resume cancel` to stop the scheduled retry
- prompts on session resume before reactivating a paused goal, and resumes explicitly with `/goal resume` from paused goals
- rejects `/goal pause` unless the goal is active and rejects `/goal resume` unless the goal is paused, except when an active goal is waiting for a user-start recovery turn after host overflow recovery; in that recovery state, `/goal resume` sends the required user follow-up instead of changing goal status
- treats completed goals as terminal for automatic transitions while allowing `/goal <objective>` and explicit `create_goal` replacement to replace goals without extra friction
- marks the goal `budgetLimited` when a positive token budget is reached
- sends hidden steering messages when budget is reached or when the agent is idle but the goal is still active
- compacts repeated hidden goal continuations before provider context so only the latest active continuation stays runnable, older ones become short bookkeeping markers, and auto-queued continuations use a compact prompt after `/goal` start or resume
- shows Codex-style status labels with compact token or elapsed-time usage in the pi footer when UI is available

Token counts are formatted with commas and compact abbreviations, for example `123M (123,456,789) tokens`. Token totals use pi's completed assistant turn input plus output usage. Cache read and cache write channels are excluded because they are provider cache accounting fields, not extra sent and received text tokens. Pi does not currently expose a separate extension usage total for automatic compaction summary calls.

## pi-queue: Multi-task orchestration

This package also includes `pi-queue`, a sequential multi-task orchestration layer built on top of the single-goal engine. It turns the single Codex-style goal into a **queue of tasks pursued one after another**: pop task 1, drive it to completion, then automatically move on to task 2, and so on.

### Quick start

```text
/queue add implement bubble sort in python
/queue add implement linear search in python
/queue add implement binary search in python
/queue start
```

The queue runs each task through the same continuation loop as `/goal <objective>` — the agent reads files, writes code, verifies, and calls `update_goal` to mark each task complete. When a task finishes, the queue automatically advances to the next pending task.

### Commands

```text
/queue add <objective>       Append a pending task to the queue
/queue list                  Show the queue status box with per-task elapsed time and tokens
/queue status                Alias for /queue list
/queue start                 Start the queue runner (kicks off task 1 immediately)
/queue pause                 Pause the queue runner (does not pause the current goal)
/queue resume                Resume a paused queue
/queue skip                  Mark the current task as skipped and advance to the next
/queue remove <index>        Remove a pending task by 1-based index
/queue clear                 Clear all tasks (requires confirmation)
/queue commit on|off         Toggle auto-commit (git add + git commit between tasks, default off)
/queue summarize on|off      Toggle auto-summarize (captures a task summary via ctx.compact, default off)
```

### Status display

`/queue list` shows an ASCII status box:

```
===========================================================================
  PI-QUEUE ORCHESTRATOR                                            [ IDLE ]
===========================================================================
  [ QUEUE STATE ]
  [x] Task 1 (12m 34s, 53k): implement bubble sort in python
  [x] Task 2 (1h 21m 21s, 893k): implement linear search in python
  [ ] Task 3: implement binary search in python
---------------------------------------------------------------------------
  Total Time: 1h 33m 55s            Total Tokens: 946k
===========================================================================
```

The footer shows a one-line status summary (`Queue 2/3, 1 remaining`) updated live while the queue is running.

### Model tools

`get_queue_status` — read-only. Returns the full queue state (tasks, cursor, settings, run state) as JSON. The model can tell the user how many tasks remain but **cannot** mutate the queue. All queue mutations are operator slash commands — the same philosophy as `update_goal` completion claims: the model must provide evidence-backed completion before the queue advances.

### Toggles: commit between tasks

When `commit on` is set (default `off`), after each task completes the queue runs:

1. `git status --porcelain` — skip if nothing to commit
2. `git add -A`
3. `git commit -m "pi-queue: <truncated objective>"`
4. `git rev-parse HEAD` — recorded on the task record

Commit messages are derived from the task objective (never from the LLM in-band). A failed commit does not block the queue — it records a warning on the task record that shows up in `/queue list`.

### Toggles: summarize between tasks

When `summarize on` is set (default `off`), after each task completes the queue calls `ctx.compact()` (the same host-provided summarization mechanism used for proactive compaction) with custom instructions asking for key decisions, touched files, remaining issues, and anything a fresh agent would need. The captured summary is prepended to the next task's startup prompt as a `<pi_queue_prior_context task_id="...">` XML fragment. If the toggle is off, the next task starts with no injected prior context.

### Persistence

Queue state is stored as JSON on disk at `<projectRoot>/.pi/pi-queue/queue.json`. Writes are atomic (write to a temp file in the same directory, then rename). A monotonic `revision` counter protects against concurrent-writer conflicts: `save` refuses to write if the on-disk revision is newer than the last loaded revision. Lightweight audit entries are also appended to the current session for local debugging but are never the source of truth for cursor or task data.

Each task gets its own fresh session context — the queue does not drag accumulated context from prior tasks forward. When the summarize toggle is on, a compact natural-language summary bridges the gap instead.

### Task lifecycle

1. **pending** — enqueued, waiting to run
2. **active** — currently being pursued by the agent (has an active `ThreadGoal`)
3. **complete** — the agent called `update_goal` with `status: "complete"`
4. **failed** — the goal ended in an unrecoverable state (future use)
5. **skipped** — skipped via `/queue skip`

When a task completes, the queue:
- Captures the completed goal's token usage onto the task record
- Marks the task `complete`
- Runs the commit flow (if enabled)
- Runs the summarize flow (if enabled)
- Advances the cursor to the next pending task
- Calls `startKickoff` to create the goal and queue a continuation turn

When a task's goal becomes `paused` or `budgetLimited` (provider limit, abort, recovery-pending), the queue pauses its runner and surfaces the status in the UI. It does **not** silently skip past the stuck task — the user must resolve the goal (`/goal resume`, `/queue skip`, `/queue retry`) before the queue advances.

### Architecture

| Module | Responsibility |
|--------|----------------|
| `src/queue-types.ts` | `QueueState`, `QueueTask`, `QueueSettings` types |
| `src/queue-state.ts` | Pure state transition functions (add, remove, advance, mark, toggle) |
| `src/queue-persistence.ts` | Atomic file-based load/save with revision conflict detection |
| `src/queue-format.ts` | ASCII status box and one-line footer formatter |
| `src/queue-git.ts` | Git commit flow via injected exec, never throws |
| `src/queue-summarize.ts` | `ctx.compact()` wrapper for task-to-task summaries |
| `src/queue-runtime-controller.ts` | Orchestrator: session events, goal transitions, auto-advance |
| `src/queue-commands.ts` | `/queue ...` command and argument completions |
| `src/queue-tools.ts` | `get_queue_status` read-only tool |

Design constraints:

- **No LLM-side queue mutation** — only one read-only tool (`get_queue_status`) is exposed. All mutations are operator slash commands.
- **Composition over duplication** — the queue composes with `GoalRuntimeController` through its public surface (`setGoal`, `getGoalForDisplay`). No forking of `state.ts` / `goal-transition.ts` / `recovery-machine.ts`.
- **Fresh sessions per task** — the source of truth is file-based (`queue.json`), not session-branch custom entries, so it survives `ctx.newSession()`.
