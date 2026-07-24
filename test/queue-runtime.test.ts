import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { GoalRuntimeController } from "../src/goal-runtime-controller.js";
import { createQueuePersistence } from "../src/queue-persistence.js";
import { createQueueRuntimeControllerForTesting } from "../src/queue-orchestrator.js";
import {
  addTask,
  advanceCursor,
  appendTask,
  createQueueState,
  createPauseTask,
  createQueueTask,
  markTaskComplete,
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
  const sentUserMessages: Array<{ content: unknown; options: unknown }> = [];
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
    sendUserMessage(content: unknown, options: unknown) {
      sentUserMessages.push({ content, options });
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
    sessionManager: {
      getSessionId: () => "test-session-id",
      getSessionFile: () => "/tmp/current-session.jsonl",
    } as ExtensionContext["sessionManager"],
    ui: {
      ...({} as ExtensionContext["ui"]),
      setStatus: (_key: string, status: string | undefined) => { statuses.push(status); },
      setWidget,
      notify: (message: string) => { notifications.push(message); },
    },
  };

  const commandCtx = {
    ...ctx,
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: false }),
  } as ExtensionCommandContext;

  return {
    pi,
    goalController,
    ctx,
    commandCtx,
    handlers,
    statuses,
    widgets,
    notifications,
    sentMessages,
    sentUserMessages,
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

test("starting a queue replaces the setup session before task 1", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  persistence.save(appendTask(persistence.load(), createQueueTask("fresh first task")));
  const fakes = runtimeFakes();
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);
  let newSessionCalls = 0;
  const commandCtx = {
    ...fakes.ctx,
    waitForIdle: async () => {},
    newSession: async () => {
      newSessionCalls++;
      return { cancelled: false };
    },
  } as ExtensionCommandContext;

  await controller.start(commandCtx);

  assert.equal(newSessionCalls, 1);
  assert.equal(controller.getQueueState().runState, "running");
  assert.equal(controller.getQueueState().tasks[0]?.status, "pending");
  assert.equal(fakes.getGoal(), null, "task 1 must not start in the setup session");

  const replacementFakes = runtimeFakes();
  const replacementController = createQueueRuntimeControllerForTesting(
    replacementFakes.pi,
    replacementFakes.goalController,
    dir,
  );
  replacementFakes.handlers.get("session_start")?.({}, replacementFakes.ctx);
  assert.equal(replacementController.getQueueState().tasks[0]?.status, "active");
  assert.equal(replacementFakes.getGoal()?.objective, "fresh first task");
});

test("resuming a paused queue also resumes its paused goal", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("paused task"));
  state = markTaskStarted(state, "session").state!;
  state = { ...state, runState: "paused" };
  persistence.save(state);

  const pausedGoal = { ...replaceGoal("paused task").goal!, status: "paused" as const };
  const fakes = runtimeFakes(pausedGoal);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  const result = await controller.resume(fakes.commandCtx);

  assert.equal(result.ok, true);
  assert.equal(controller.getQueueState().runState, "running");
  assert.equal(fakes.getGoal()?.status, "active");
  assert.equal(fakes.getResumedGoals(), 1);
});

test("skipping an active task clears its goal and replaces the session before the next task", async () => {
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

  const result = await controller.skip(fakes.commandCtx);

  assert.equal(result.ok, true);
  assert.equal(controller.getQueueState().tasks[0]?.status, "skipped");
  assert.equal(controller.getQueueState().tasks[1]?.status, "pending");
  assert.equal(controller.getQueueState().cursor, 1);
  assert.equal(fakes.getClearedGoals(), 1);
  assert.equal(fakes.getGoal(), null);
  assert.equal(fakes.sentMessages.length, 0);

  const replacementFakes = runtimeFakes();
  const replacementController = createQueueRuntimeControllerForTesting(
    replacementFakes.pi,
    replacementFakes.goalController,
    dir,
  );
  replacementFakes.handlers.get("session_start")?.({}, replacementFakes.ctx);
  assert.equal(replacementController.getQueueState().tasks[1]?.status, "active");
  assert.equal(replacementFakes.getGoal()?.objective, "second task");
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
  assert.equal(controller.getQueueState().tasks[1]?.status, "pending");
  assert.equal(controller.getQueueState().tasks[1]?.kind, "pause");
  assert.equal(controller.getQueueState().tasks[2]?.status, "pending");
  assert.equal(controller.getQueueState().runState, "running");

  // Session replacement reloads the extension; session_start in the fresh
  // instance reaches the pause without carrying the completed task's context.
  const replacementFakes = runtimeFakes();
  const replacementController = createQueueRuntimeControllerForTesting(
    replacementFakes.pi,
    replacementFakes.goalController,
    dir,
  );
  replacementFakes.handlers.get("session_start")?.({}, replacementFakes.ctx);

  assert.equal(replacementController.getQueueState().tasks[1]?.status, "active");
  assert.equal(replacementController.getQueueState().runState, "paused");
  assert.match(replacementFakes.notifications.at(-1) ?? "", /human pause/);

  const resumed = await replacementController.resume(replacementFakes.commandCtx);
  assert.equal(resumed.ok, true);
  assert.equal(replacementController.getQueueState().tasks[1]?.status, "complete");
  assert.equal(replacementController.getQueueState().tasks[2]?.status, "pending");
  assert.equal(replacementController.getQueueState().runState, "running");

  const afterPauseFakes = runtimeFakes();
  const afterPauseController = createQueueRuntimeControllerForTesting(
    afterPauseFakes.pi,
    afterPauseFakes.goalController,
    dir,
  );
  afterPauseFakes.handlers.get("session_start")?.({}, afterPauseFakes.ctx);
  assert.equal(afterPauseController.getQueueState().tasks[2]?.status, "active");
  assert.equal(afterPauseFakes.getGoal()?.objective, "after approval");
});

test("completed tasks replace the session before the next task starts", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("first task"));
  state = appendTask(state, createQueueTask("second task"));
  state = setRunState(state, "running");
  state = markTaskStarted(state, "old-session").state!;
  persistence.save(state);

  const completedGoal = { ...replaceGoal("first task").goal!, status: "complete" as const };
  const fakes = runtimeFakes(completedGoal);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  await fakes.handlers.get("agent_end")?.({}, fakes.ctx);

  const pendingTask = controller.getQueueState().tasks[1]!;
  assert.equal(pendingTask.status, "pending");
  assert.equal(fakes.getGoal()?.objective, "first task");
  assert.equal(fakes.sentMessages.length, 0, "next task must not start in the old session");
  assert.equal(fakes.sentUserMessages.length, 0, "queue control must never be sent to the model as a user message");

  let waitedForIdle = 0;
  let newSessionParent: string | undefined;
  const commandCtx = {
    ...fakes.ctx,
    waitForIdle: async () => { waitedForIdle++; },
    newSession: async (options?: { parentSession?: string }) => {
      newSessionParent = options?.parentSession;
      return { cancelled: false };
    },
  } as ExtensionCommandContext;
  const transition = await controller.startNextTaskInFreshSession(pendingTask.taskId, commandCtx);

  assert.equal(transition.ok, true);
  assert.equal(waitedForIdle, 1);
  assert.equal(newSessionParent, "/tmp/current-session.jsonl");

  const replacementFakes = runtimeFakes();
  const replacementController = createQueueRuntimeControllerForTesting(
    replacementFakes.pi,
    replacementFakes.goalController,
    dir,
  );
  replacementFakes.handlers.get("session_start")?.({}, replacementFakes.ctx);

  assert.equal(replacementController.getQueueState().tasks[1]?.status, "active");
  assert.equal(replacementController.getQueueState().tasks[1]?.sessionId, "test-session-id");
  assert.equal(replacementFakes.getGoal()?.objective, "second task");
  assert.equal(replacementFakes.sentMessages.length, 1);
});

test("the command-owned session chain advances across every pending task", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("first task"));
  state = appendTask(state, createQueueTask("second task"));
  state = setRunState(state, "running");
  persistence.save(state);

  const fakes = runtimeFakes();
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);
  const transitionPersistence = createQueuePersistence({ projectRoot: dir });
  let replacementCount = 0;

  const replaceSession: ExtensionCommandContext["newSession"] = async (options) => {
    replacementCount++;

    // Simulate the replacement runtime's session_start plus a completed goal
    // run before its withSession callback regains control.
    let latest = transitionPersistence.load();
    const started = markTaskStarted(latest, `fresh-session-${replacementCount}`);
    assert.ok(started.ok && started.state);
    latest = started.state;
    const completed = markTaskComplete(latest);
    assert.ok(completed.ok && completed.state);
    latest = advanceCursor(completed.state).state;
    transitionPersistence.save(latest);

    const freshCtx = {
      ...fakes.commandCtx,
      newSession: replaceSession,
      sendMessage: async () => {},
      sendUserMessage: async () => {},
    };
    await options?.withSession?.(freshCtx);
    return { cancelled: false };
  };
  const commandCtx = {
    ...fakes.commandCtx,
    newSession: replaceSession,
  } as ExtensionCommandContext;

  const firstTaskId = controller.getQueueState().tasks[0]?.taskId;
  assert.ok(firstTaskId);
  const transition = await controller.startNextTaskInFreshSession(firstTaskId, commandCtx);

  assert.equal(transition.ok, true);
  assert.equal(replacementCount, 2);
  const finalState = transitionPersistence.load();
  assert.deepEqual(finalState.tasks.map((task) => task.status), ["complete", "complete"]);
  assert.equal(finalState.runState, "idle");
  assert.equal(fakes.sentUserMessages.length, 0);
});

test("cancelled session replacement pauses instead of reusing the old context", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("first task"));
  state = appendTask(state, createQueueTask("second task"));
  state = setRunState(state, "running");
  state = markTaskStarted(state, "old-session").state!;
  persistence.save(state);

  const completedGoal = { ...replaceGoal("first task").goal!, status: "complete" as const };
  const fakes = runtimeFakes(completedGoal);
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);
  await fakes.handlers.get("agent_end")?.({}, fakes.ctx);
  const nextTask = controller.getQueueState().tasks[1]!;
  const commandCtx = {
    ...fakes.ctx,
    waitForIdle: async () => {},
    newSession: async () => ({ cancelled: true }),
  } as ExtensionCommandContext;

  const transition = await controller.startNextTaskInFreshSession(nextTask.taskId, commandCtx);

  assert.equal(transition.ok, false);
  assert.equal(controller.getQueueState().runState, "paused");
  assert.equal(controller.getQueueState().tasks[1]?.status, "pending");
  assert.equal(fakes.getGoal()?.objective, "first task");
  assert.match(fakes.notifications.at(-1) ?? "", /queue is paused/);

  const resumed = await controller.resume(fakes.commandCtx);
  assert.equal(resumed.ok, true);
  assert.equal(controller.getQueueState().tasks[1]?.status, "pending");
  assert.equal(fakes.sentMessages.length, 0);
  assert.equal(fakes.sentUserMessages.length, 0);
});

test("summarize mode carries only the captured summary into the fresh task session", async () => {
  const dir = tempDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  let state = appendTask(persistence.load(), createQueueTask("first task"));
  state = appendTask(state, createQueueTask("second task"));
  state = setSummarizeSetting(state, true);
  state = setRunState(state, "running");
  state = markTaskStarted(state, "old-session").state!;
  persistence.save(state);

  const completedGoal = { ...replaceGoal("first task").goal!, status: "complete" as const };
  const fakes = runtimeFakes(completedGoal);
  fakes.ctx.compact = (options) => {
    options?.onComplete?.({
      summary: "Touched src/first.ts; no remaining issues.",
      firstKeptEntryId: "kept-entry",
      tokensBefore: 100,
    });
  };
  const controller = createQueueRuntimeControllerForTesting(fakes.pi, fakes.goalController, dir);

  await fakes.handlers.get("agent_end")?.({}, fakes.ctx);
  assert.equal(controller.getQueueState().tasks[0]?.summary, "Touched src/first.ts; no remaining issues.");
  assert.equal(controller.getQueueState().tasks[1]?.status, "pending");

  const replacementFakes = runtimeFakes();
  createQueueRuntimeControllerForTesting(replacementFakes.pi, replacementFakes.goalController, dir);
  replacementFakes.handlers.get("session_start")?.({}, replacementFakes.ctx);

  const objective = replacementFakes.getGoal()?.objective ?? "";
  assert.match(objective, /^<pi_queue_prior_context/);
  assert.match(objective, /Touched src\/first\.ts; no remaining issues\./);
  assert.match(objective, /second task$/);
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
