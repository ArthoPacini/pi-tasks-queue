import assert from "node:assert/strict";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GoalRuntimeController } from "../src/goal-runtime-controller.js";
import { createQueuePersistence } from "../src/queue-persistence.js";
import { createQueueRuntimeControllerForTesting } from "../src/queue-orchestrator.js";
import {
  addTask,
  appendTask,
  createQueueState,
  createPauseTask,
  createQueueTask,
  markTaskStarted,
  setCommitSetting,
  setRunState,
  setStatusWidgetSetting,
  setSummarizeSetting,
} from "../src/queue-state.js";
import type { QueueState } from "../src/queue-types.js";
import { replaceGoal } from "../src/state.js";
import type { ThreadGoal } from "../src/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "queue-runtime-test-"));
}

function runtimeFakes(
  initialGoal: ThreadGoal | null = null,
  exec: ExtensionAPI["exec"] = async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
) {
  const handlers = new Map<string, (event: object, ctx: ExtensionContext) => void | Promise<void>>();
  const statuses: Array<string | undefined> = [];
  const widgets: Array<string[] | undefined> = [];
  const notifications: string[] = [];
  const sentMessages: unknown[] = [];
  let goal = initialGoal;
  let clearedGoals = 0;
  let resumedGoals = 0;

  const on = ((event: string, handler: (event: object, ctx: ExtensionContext) => void | Promise<void>) => {
    handlers.set(event, handler);
  }) as ExtensionAPI["on"];
  const pi = {
    ...({} as ExtensionAPI),
    appendEntry() {},
    exec,
    on,
    sendMessage(message: unknown) {
      sentMessages.push(message);
    },
  };
  const goalController = {
    ...({} as GoalRuntimeController),
    getGoalForDisplay: () => goal,
    setGoal(nextGoal: ThreadGoal) {
      goal = nextGoal;
    },
    clearGoal() {
      goal = null;
      clearedGoals++;
    },
    resumeGoalWithContinuation() {
      goal = goal ? { ...goal, status: "active" } : null;
      resumedGoals++;
      return { ok: true, message: "Goal resumed.", goal };
    },
  };
  const setWidget: ExtensionContext["ui"]["setWidget"] = (_key, content) => {
    widgets.push(Array.isArray(content) ? content : undefined);
  };
  const ctx = {
    ...({} as ExtensionContext),
    ui: {
      ...({} as ExtensionContext["ui"]),
      setStatus: (_key: string, status: string | undefined) => { statuses.push(status); },
      setWidget,
      notify: (message: string) => { notifications.push(message); },
    },
  };

  return {
    pi,
    goalController,
    ctx,
    handlers,
    statuses,
    widgets,
    notifications,
    sentMessages,
    getGoal: () => goal,
    getClearedGoals: () => clearedGoals,
    getResumedGoals: () => resumedGoals,
  };
}

test("session startup restores the queue footer status", () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  const state = appendTask(persistence.load(), createQueueTask("waiting task"));
  persistence.save(state);
  const fakes = runtimeFakes();

  createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);
  fakes.handlers.get("session_start")?.({}, fakes.ctx);

  assert.equal(fakes.statuses.at(-1), "Queue 0/1, 1 remaining");
});

test("session startup restores the optional live queue widget", () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("visible task"));
  state = setStatusWidgetSetting(state, true);
  persistence.save(state);
  const fakes = runtimeFakes();

  createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);
  fakes.handlers.get("session_start")?.({}, fakes.ctx);

  assert.match(fakes.widgets.at(-1)?.join("\n") ?? "", /visible task/);
});

test("session startup restores a running active task when its session goal is missing", () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("restore me"));
  state = setRunState(state, "running");
  state = markTaskStarted(state, "old-session").state!;
  persistence.save(state);
  const fakes = runtimeFakes();
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  fakes.handlers.get("session_start")?.({}, fakes.ctx);

  assert.equal(controller.getQueueState().tasks[0]?.status, "active");
  assert.equal(fakes.getGoal()?.objective, "restore me");
  assert.equal(fakes.sentMessages.length, 1);
  assert.equal(fakes.statuses.at(-1), "Queue 0/1, 1 remaining");
});

test("resuming a paused queue also resumes its paused goal", () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("paused task"));
  state = markTaskStarted(state, "session").state!;
  state = { ...state, runState: "paused" };
  persistence.save(state);

  const pausedGoal = { ...replaceGoal("paused task").goal!, status: "paused" as const };
  const fakes = runtimeFakes(pausedGoal);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  const result = controller.resume(fakes.ctx);

  assert.equal(result.ok, true);
  assert.equal(controller.getQueueState().runState, "running");
  assert.equal(fakes.getGoal()?.status, "active");
  assert.equal(fakes.getResumedGoals(), 1);
});

test("skipping an active task clears its goal and starts the next task", () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("first task"));
  state = appendTask(state, createQueueTask("second task"));
  state = setRunState(state, "running");
  state = markTaskStarted(state, "session").state!;
  persistence.save(state);

  const firstGoal = replaceGoal("first task").goal!;
  const fakes = runtimeFakes(firstGoal);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  const result = controller.skip(fakes.ctx);

  assert.equal(result.ok, true);
  assert.equal(controller.getQueueState().tasks[0]?.status, "skipped");
  assert.equal(controller.getQueueState().tasks[1]?.status, "active");
  assert.equal(controller.getQueueState().cursor, 1);
  assert.equal(fakes.getClearedGoals(), 1);
  assert.equal(fakes.getGoal()?.objective, "second task");
  assert.equal(fakes.sentMessages.length, 1);
});

test("a queued human pause blocks advancement until resume", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("first task"));
  state = appendTask(state, createPauseTask());
  state = appendTask(state, createQueueTask("after approval"));
  state = setRunState(state, "running");
  state = markTaskStarted(state, "session").state!;
  persistence.save(state);

  const completedGoal = { ...replaceGoal("first task").goal!, status: "complete" as const };
  const fakes = runtimeFakes(completedGoal);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  await fakes.handlers.get("agent_end")?.({}, fakes.ctx);

  assert.equal(controller.getQueueState().tasks[0]?.status, "complete");
  assert.equal(controller.getQueueState().tasks[1]?.status, "active");
  assert.equal(controller.getQueueState().tasks[1]?.kind, "pause");
  assert.equal(controller.getQueueState().tasks[2]?.status, "pending");
  assert.equal(controller.getQueueState().runState, "paused");
  assert.match(fakes.notifications.at(-1) ?? "", /human pause/);

  const resumed = controller.resume(fakes.ctx);
  assert.equal(resumed.ok, true);
  assert.equal(controller.getQueueState().tasks[1]?.status, "complete");
  assert.equal(controller.getQueueState().tasks[2]?.status, "active");
  assert.equal(controller.getQueueState().runState, "running");
  assert.equal(fakes.getGoal()?.objective, "after approval");
});

test("agent_end awaits commit-between-tasks and records the commit", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("commit this task"));
  state = setCommitSetting(state, true);
  state = setRunState(state, "running");
  state = markTaskStarted(state, "session").state!;
  persistence.save(state);

  const calls: Array<{ command: string; args: string[]; cwd: string | undefined }> = [];
  const outputs = [" M changed.txt\n", "", "", "abc123def456\n"];
  const exec: ExtensionAPI["exec"] = async (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    return { stdout: outputs[calls.length - 1] ?? "", stderr: "", code: 0, killed: false };
  };
  const completedGoal = { ...replaceGoal("commit this task").goal!, status: "complete" as const };
  const fakes = runtimeFakes(completedGoal, exec);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  await fakes.handlers.get("agent_end")?.({}, fakes.ctx);

  assert.deepEqual(calls.map((call) => [call.command, ...call.args]), [
    ["git", "status", "--porcelain"],
    ["git", "add", "-A"],
    ["git", "commit", "-m", "pi-queue: commit this task"],
    ["git", "rev-parse", "HEAD"],
  ]);
  assert.ok(calls.every((call) => call.cwd === dir));
  assert.equal(controller.getQueueState().tasks[0]?.commitSha, "abc123def456");
});

test("queue persistence round-trips state through file", () => {
  const dir = tempDir();
  const p = createQueuePersistence({ projectRoot: dir });

  let state = p.load();
  assert.equal(state.tasks.length, 0);
  assert.equal(state.revision, 0);

  const t1 = createQueueTask("first task", null, 100);
  state = appendTask(state, t1, 101);
  state = setRunState(state, "running", 102);
  p.save(state);

  const p2 = createQueuePersistence({ projectRoot: dir });
  const loaded = p2.load();
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0]?.objective, "first task");
  assert.equal(loaded.runState, "running");
  assert.ok(loaded.revision > 0);
});

test("pure queue operations through full lifecycle", () => {
  let state = createQueueState(0);

  // Add 2 pending tasks
  const t1 = createQueueTask("Setup", null, 0);
  const t2 = createQueueTask("Build", null, 0);
  state = appendTask(state, t1, 1);
  state = appendTask(state, t2, 2);

  // Start queue
  state = setRunState(state, "running", 3);

  // Start task 1
  const sessionId = "session-1";
  const started = (calls: { sid: string }) => (s: QueueState) => {
    // Simulate markTaskStarted
    const task = s.tasks[s.cursor];
    if (!task || task.status !== "pending") return s;
    return {
      ...s,
      tasks: s.tasks.map((t) =>
        t.taskId === task.taskId ? { ...t, status: "active" as const, startedAt: 10, sessionId: calls.sid } : t,
      ),
      revision: s.revision + 1,
      updatedAt: 10,
    };
  };
  state = started({ sid: sessionId })(state);

  assert.equal(state.tasks[0]?.status, "active");
  assert.equal(state.tasks[0]?.sessionId, "session-1");

  // Complete task 1 (simulate goal reaching complete status)
  const completed1 = (() => {
    const task = state.tasks[state.cursor];
    if (!task) return state;
    return {
      ...state,
      tasks: state.tasks.map((t) =>
        t.taskId === task.taskId ? { ...t, status: "complete" as const, completedAt: 20 } : t,
      ),
      revision: state.revision + 1,
      updatedAt: 20,
    };
  })();

  assert.equal(completed1.tasks[0]?.status, "complete");

  // Advance cursor to task 2
  const nextIdx = completed1.tasks.findIndex((t, i) => i > completed1.cursor && t.status === "pending");
  const advanced = {
    ...completed1,
    cursor: nextIdx,
    revision: completed1.revision + 1,
    updatedAt: 30,
  };

  assert.equal(advanced.cursor, 1);
});

test("queue with commit setting toggles correctly", () => {
  let state = createQueueState(0);
  assert.equal(state.settings.commitBetweenTasks, false);

  state = setCommitSetting(state, true, 1);
  assert.equal(state.settings.commitBetweenTasks, true);

  state = setCommitSetting(state, false, 2);
  assert.equal(state.settings.commitBetweenTasks, false);
});

test("queue with summarize setting toggles correctly", () => {
  let state = createQueueState(0);
  assert.equal(state.settings.summarizeBetweenTasks, false);

  state = setSummarizeSetting(state, true, 1);
  assert.equal(state.settings.summarizeBetweenTasks, true);

  state = setSummarizeSetting(state, false, 2);
  assert.equal(state.settings.summarizeBetweenTasks, false);
});

test("queue persist to disk survives second load", () => {
  const dir = tempDir();
  const p = createQueuePersistence({ projectRoot: dir });

  let state = p.load();

  // Add tasks
  state = appendTask(state, createQueueTask("Task A", null, 0), 1);
  state = appendTask(state, createQueueTask("Task B", null, 0), 2);
  state = setRunState(state, "running", 3);
  p.save(state);

  // Second instance reads it back
  const p2 = createQueuePersistence({ projectRoot: dir });
  const loaded = p2.load();

  assert.equal(loaded.tasks.length, 2);
  assert.equal(loaded.tasks[0]?.objective, "Task A");
  assert.equal(loaded.tasks[1]?.objective, "Task B");
  assert.equal(loaded.runState, "running");
});
