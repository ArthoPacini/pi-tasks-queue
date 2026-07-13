# pi-tasks-queue

A queue of tasks for pi. Add tasks, start the queue, watch it work through them one at a time.

Built on top of the pi-codex-goal https://github.com/fitchmultz/pi-codex-goal by fitchmultz https://github.com/fitchmultz (`/goal`, `create_goal`, `get_goal`, `update_goal`). Each task gets its own fresh session context. When a task finishes, the queue automatically advances to the next one.

## Quick start

```text
/queue add implement bubble sort in python
/queue add implement linear search in python
/queue add implement binary search in python
/queue start
```

The agent works through each task, calls `update_goal` to mark it complete. Then the queue kicks off the next task.

## Commands

| Command | What it does |
|---------|-------------|
| `/queue add <objective>` | Append a pending task |
| `/queue list` or `/queue status` | Show the status box with per-task time/tokens and totals |
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
  [x] Task 1 (34s, 4k): implement bubble sort in python
  [x] Task 2 (22s, 3k): implement linear search in python
  [ ] Task 3: implement binary search in python
---------------------------------------------------------------------------
  Total Time: 56s                Total Tokens: 7k
===========================================================================
```

Completed tasks show elapsed time and tokens. The bottom row shows the grand total across all tasks.

## Model tools

`get_queue_status` — read-only. Returns the queue state as JSON. The model can tell you how many tasks remain but **cannot** change the queue. Only `/queue` slash commands mutate tasks — same philosophy as `update_goal` needing evidence before marking complete.

## Toggle: commit between tasks

Default off. When on, after each task completes:

```sh
git status --porcelain   # skip if nothing to commit
git add -A
git commit -m "pi-queue: <truncated objective>"
```

The commit message comes from the task objective, never from the LLM. If the commit fails, the queue records a warning on the task (visible in `/queue list`) and keeps going.

## Toggle: summarize between tasks

Default off. When on, after each task completes the queue runs `ctx.compact()` to capture key decisions, touched files, and remaining issues. That summary is injected into the next task's startup prompt as `<pi_queue_prior_context>`. If off, each task starts fresh with no prior context.

## Task states

| State | Meaning |
|-------|---------|
| `pending` | Enqueued, waiting to run |
| `active` | Agent is working on it right now |
| `complete` | Agent called `update_goal` on it |
| `skipped` | Skipped via `/queue skip` |
| `failed` | Unrecoverable error (future use) |

When a task's goal gets paused (abort, provider limit, recovery), the queue pauses too — it won't silently skip past a stuck task. Resolve the goal with `/goal resume` or skip the task with `/queue skip`.

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
