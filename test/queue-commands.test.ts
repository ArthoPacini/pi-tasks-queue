import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import test from "node:test";

import { handleQueueCommand } from "../src/queue-commands.js";
import {
  advanceCursor,
  appendTask,
  createQueueState,
  createQueueTask,
  resumeQueue,
  setRunState,
  skipCurrentTask,
} from "../src/queue-state.js";
import type { QueueState } from "../src/queue-types.js";

/** Minimal context shape matching what handleQueueCommand actually uses. */
interface MinCommandContext {
  hasUI: boolean;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string): Promise<boolean>;
    setStatus(key: string, text: string | undefined): void;
  };
}

interface TestQueueHost {
  getQueueState(): QueueState;
  updateQueueState(transform: (state: QueueState) => QueueState): QueueState;
  persistQueueState(): void;
  refreshUi(ctx: ExtensionContext): void;
  start(ctx: ExtensionContext): void;
  resume(ctx: ExtensionContext): ReturnType<typeof resumeQueue>;
  skip(ctx: ExtensionContext): ReturnType<typeof skipCurrentTask>;
}

function createTestHost(initial: QueueState = createQueueState()): TestQueueHost {
  let state = initial;
  return {
    getQueueState: () => state,
    updateQueueState: (transform) => {
      state = transform(state);
      return state;
    },
    persistQueueState: () => {},
    refreshUi: () => {},
    start: () => {
      state = setRunState(state, "running");
    },
    resume: () => {
      const result = resumeQueue(state);
      if (result.state) state = result.state;
      return result;
    },
    skip: () => {
      const result = skipCurrentTask(state);
      if (result.state) state = advanceCursor(result.state).state;
      return result;
    },
  };
}

function runCmd(
  host: TestQueueHost,
  args: string,
  notifications: string[],
  confirmResult = true,
): void | Promise<void> {
  const ctx: MinCommandContext = {
    hasUI: true,
    ui: {
      notify(message: string) { notifications.push(message); },
      confirm: async () => confirmResult,
      setStatus: () => {},
    },
  };
  return handleQueueCommand(host, args, ctx);
}

test("/queue add appends a task", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "add Do something", notifications);

  assert.equal(host.getQueueState().tasks.length, 1);
  assert.equal(host.getQueueState().tasks[0]?.objective, "Do something");
  assert.match(notifications.at(-1) ?? "", /Task added/);
});

test("/queue add notification previews only the trimmed first line", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, `add ${"x".repeat(100)}\nsecond line`, notifications);

  assert.equal(host.getQueueState().tasks[0]?.objective, `${"x".repeat(100)}\nsecond line`);
  assert.equal(notifications.at(-1), `Task added: ${"x".repeat(57)}...`);
});

test("/queue add validates empty objective", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "add   ", notifications);

  assert.equal(host.getQueueState().tasks.length, 0);
  assert.equal(notifications.at(-1), "Usage: /queue add <objective>");
});

test("/queue list shows status box", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "list", notifications);

  assert.ok(notifications.at(-1)?.includes("PI-QUEUE ORCHESTRATOR"));
});

test("/queue status is an alias for list", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "status", notifications);

  assert.ok(notifications.at(-1)?.includes("PI-QUEUE ORCHESTRATOR"));
});

test("/queue start sets runState to running", async () => {
  const notifications: string[] = [];
  const state = appendTask(createQueueState(0), createQueueTask("task1", null, 0));
  const host = createTestHost(state);

  await runCmd(host, "start", notifications);

  assert.equal(host.getQueueState().runState, "running");
  assert.match(notifications.at(-1) ?? "", /Queue started/);
});

test("/queue start fails without pending tasks", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "start", notifications);

  assert.equal(host.getQueueState().runState, "idle");
  assert.equal(notifications.at(-1), "No pending tasks to run.");
});

test("/queue pause pauses a running queue", async () => {
  const notifications: string[] = [];
  const state = setRunState(createQueueState(0), "running");
  const host = createTestHost(state);

  await runCmd(host, "pause", notifications);

  assert.equal(host.getQueueState().runState, "paused");
});

test("/queue pause fails on idle queue", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "pause", notifications);

  assert.equal(notifications.at(-1), "Queue is not running.");
});

test("/queue resume resumes a paused queue", async () => {
  const notifications: string[] = [];
  const state = appendTask(
    { ...createQueueState(0), runState: "paused" as const },
    createQueueTask("task1", null, 0),
  );
  const host = createTestHost(state);

  await runCmd(host, "resume", notifications);

  assert.equal(host.getQueueState().runState, "running");
});

test("/queue skip skips the current task and advances", async () => {
  const notifications: string[] = [];
  const state = appendTask(
    appendTask(createQueueState(0), createQueueTask("task1", null, 0)),
    createQueueTask("task2", null, 0),
  );
  const host = createTestHost(state);

  await runCmd(host, "skip", notifications);

  assert.equal(host.getQueueState().tasks[0]?.status, "skipped");
  assert.equal(host.getQueueState().cursor, 1);
});

test("/queue remove removes a pending task by 1-based index", async () => {
  const notifications: string[] = [];
  const state = appendTask(
    appendTask(createQueueState(0), createQueueTask("task1", null, 0)),
    createQueueTask("task2", null, 0),
  );
  const host = createTestHost(state);

  await runCmd(host, "remove 2", notifications);

  assert.equal(host.getQueueState().tasks.length, 1);
  assert.equal(host.getQueueState().tasks[0]?.objective, "task1");
});

test("/queue remove validates index", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "remove abc", notifications);

  assert.equal(notifications.at(-1), "Invalid index. Use the 1-based number shown in /queue list.");
});

test("/queue clear requires confirmation", async () => {
  const notifications: string[] = [];
  const state = appendTask(createQueueState(0), createQueueTask("task1", null, 0));
  const host = createTestHost(state);

  await runCmd(host, "clear", notifications, false);

  assert.equal(host.getQueueState().tasks.length, 1);
  assert.equal(notifications.at(-1), "Queue unchanged.");
});

test("/queue clear with confirmation clears tasks", async () => {
  const notifications: string[] = [];
  const state = appendTask(createQueueState(0), createQueueTask("task1", null, 0));
  const host = createTestHost(state);

  await runCmd(host, "clear", notifications, true);

  assert.equal(host.getQueueState().tasks.length, 0);
  assert.equal(notifications.at(-1), "Queue cleared.");
});

test("/queue commit on|off toggles commit setting", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "commit on", notifications);
  assert.equal(host.getQueueState().settings.commitBetweenTasks, true);

  await runCmd(host, "commit off", notifications);
  assert.equal(host.getQueueState().settings.commitBetweenTasks, false);
});

test("/queue summarize on|off toggles summarize setting", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "summarize on", notifications);
  assert.equal(host.getQueueState().settings.summarizeBetweenTasks, true);

  await runCmd(host, "summarize off", notifications);
  assert.equal(host.getQueueState().settings.summarizeBetweenTasks, false);
});

test("/queue unknown subcommand shows help", async () => {
  const notifications: string[] = [];
  const host = createTestHost();

  await runCmd(host, "unknown-thing", notifications);

  assert.ok(notifications.at(-1)?.includes("Unknown subcommand"));
  assert.ok(notifications.at(-1)?.includes("add"));
});
