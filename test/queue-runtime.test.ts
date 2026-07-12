import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQueuePersistence } from "../src/queue-persistence.js";
import {
  addTask,
  appendTask,
  createQueueState,
  createQueueTask,
  setCommitSetting,
  setRunState,
  setSummarizeSetting,
} from "../src/queue-state.js";
import type { QueueState } from "../src/queue-types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "queue-runtime-test-"));
}

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
