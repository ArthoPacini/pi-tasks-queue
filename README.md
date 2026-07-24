# pi-tasks-queue

A queue of tasks for pi. Add tasks, start the queue, watch it work through them one at a time.

Built on top of the pi-codex-goal https://github.com/fitchmultz/pi-codex-goal by fitchmultz https://github.com/fitchmultz (`/goal`, `create_goal`, `get_goal`, `update_goal`). Each task gets its own fresh session context. When a task finishes, the queue automatically advances to the next one.

## Quick start

```text
/queue add implement bubble sort in python
/queue add implement linear search in python
/queue add implement binary search in python
/queue add pause
/queue add document the completed algorithms
/queue start
```

The agent works through each task, calls `update_goal` to mark it complete. Then the queue kicks off the next task.

## Commands

| Command | What it does |
|---------|-------------|
| `/queue add <objective>` | Append a pending task |
| `/queue add pause` | Append a human checkpoint; the queue stops there until `/queue resume` |
| `/queue edit <index>` | Open a pending task in the editor (inline replacement text is also accepted) |
| `/queue list` or `/queue status` | Show the status box with per-task time/tokens, settings, and totals |
| `/queue status toggle` | Toggle a persistent live queue widget (`on` and `off` are also accepted) |
| `/queue start` | Start the queue runner — kicks off task 1 immediately |
| `/queue pause` | Pause the queue (current goal keeps running, queue won't advance) |
| `/queue resume` | Resume a paused queue |
| `/queue skip` | Skip the current task, move to the next |
| `/queue remove <index>` | Remove a pending task by its 1-based number |
| `/queue clear` | Clear all tasks (asks for confirmation) |
| `/queue commit on` or `off` | Auto-commit between tasks via `git add -A && git commit` |
| `/queue summarize on` or `off` | Auto-summarize between tasks via `ctx.compact()` |

## Status display

```
===========================================================================
  PI-QUEUE ORCHESTRATOR                                            [ IDLE ]
===========================================================================
  [ QUEUE STATE ]
  Commit: ON  |  Summarize: OFF  |  Live status: ON
  [x] Task 1 (34s, 4k): implement bubble sort in python
  [x] Task 2 (22s, 3k): implement linear search in python
  [ ] Task 3: implement binary search in python
---------------------------------------------------------------------------
  Total Time: 56s                Total Tokens: 7k
===========================================================================
```

Completed tasks show elapsed time and tokens. The bottom row shows the grand total across all tasks. Task rows use a trimmed first-line preview; the full objective is still kept for the agent. Commit, summarize, and live-widget modes are shown in the status box, and commit mode is also visible in the compact footer. A compact queue status is restored in the footer when pi starts. Turn on `/queue status toggle` to keep the task list visible above the editor and refresh it as the queue advances.

`/queue edit 2` opens task 2 in pi's editor. Only `pending` entries can be changed; once a task has become active or terminal its recorded objective is immutable. `/queue edit 2 replacement objective` is available for non-interactive use.

## Model tools

- `get_queue_status` reads tasks, progress, settings, and run state.
- `add_queue_tasks` appends one or more tasks and human pause checkpoints in an explicit order. It does not start the queue.
- `edit_queue_task` replaces the objective of a pending task by its 1-based number.

These native tools are the interface the agent needs to manage its own queue. Their prompt metadata teaches the agent when queue mutation is appropriate, so a separate skill is not required. Mutating tools run sequentially to preserve ordering when a model emits multiple tool calls.

You can therefore use a normal prompt instead of slash commands:

```text
Read ./tasks and create its tasks in the queue. Preserve their order and add human pauses wherever the file requests one. Do not start the queue yet.
```

The agent reads the file with its normal `read` tool, interprets the task list, and calls `add_queue_tasks`. The queue remains ready for a later `/queue start` unless the prompt also explicitly asks to start it.

## Toggle: commit between tasks

Default off. When on, after each task completes (before the next task or human pause):

```sh
git status --porcelain   # skip if nothing to commit
git add -A
git commit -m "pi-queue: <truncated objective>"
```

The commit message comes from the task objective, never from the LLM. If any git step fails, the queue records a warning on the task (visible in `/queue list`) and keeps going. Git commands run in the queue's project root, and the queue waits for the commit attempt to finish before advancing.

## Toggle: summarize between tasks

Default off. When on, after each task completes the queue runs `ctx.compact()` to capture key decisions, touched files, and remaining issues. That summary is injected into the next task's startup prompt as `<pi_queue_prior_context>`. If off, each task starts fresh with no prior context.

## Task states

| State | Meaning |
|-------|---------|
| `pending` | Enqueued, waiting to run |
| `active` | Agent is working on it, or the queue is waiting at an active human pause |
| `complete` | Agent called `update_goal` on it |
| `skipped` | Skipped via `/queue skip` |
| `failed` | Unrecoverable error (future use) |

When a task's goal gets paused (abort, provider limit, recovery), the queue pauses too — it won't silently skip past a stuck task. Resolve the goal with `/goal resume` or skip the task with `/queue skip`.

A human pause is a queue entry, not an agent goal. When reached, it becomes active and the queue enters `paused`; `/queue resume` completes that checkpoint and starts the next pending task.

## Install

```sh
pi install npm:pi-tasks-queue
```

For local development:

```sh
npm install
pi install .
```

## Development

```sh
npm run verify     # typecheck + tests
```

The original `pi-codex-goal` single-goal engine (`/goal`, `create_goal`, `get_goal`, `update_goal`) is still fully present and unchanged. The queue composes with it through its public API — it's purely additive.
