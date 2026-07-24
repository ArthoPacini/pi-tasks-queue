import assert from "node:assert/strict";
import test from "node:test";

import {
  formatQueueFooterStatus,
  formatQueueStateJson,
  formatQueueStatusBox,
  formatQueueWidgetLines,
  formatQueueTaskStatusList,
  formatTaskPreview,
} from "../src/queue-format.js";
import { appendTask, createPauseTask, createQueueState, createQueueTask, setCommitSetting } from "../src/queue-state.js";

test("formatQueueStatusBox shows idle empty queue", () => {
  const state = createQueueState(100);
  const box = formatQueueStatusBox(state);

  assert.match(box, /PI-QUEUE ORCHESTRATOR/);
  assert.match(box, /\[ IDLE \]/);
  assert.match(box, /\(no tasks\)/);
  assert.match(box, /Commit: OFF/);
});

test("formatQueueStatusBox shows tasks and active goal", () => {
  const state = createQueueState(0);
  const t1 = createQueueTask("Setup database schema", null, 0);
  const t2 = createQueueTask("Create API routes", null, 0);
  const t3 = createQueueTask("Implement Svelte 5 reactive stores", null, 0);
  const withAll = appendTask(appendTask(appendTask(state, t1), t2), t3);
  // Mark first complete, second active (started), cursor at 1
  const started = { ...withAll, cursor: 1 };
  const active = {
    ...started,
    tasks: started.tasks.map((t, i) =>
      i === 0
        ? { ...t, status: "complete" as const, commitSha: "a1b2c3d4e5f6" }
        : i === 1
          ? { ...t, status: "active" as const, startedAt: 100 }
          : t,
    ),
  };
  // Third is still pending

  const box = formatQueueStatusBox(active);

  assert.match(box, /PI-QUEUE ORCHESTRATOR/);
  assert.match(box, /\[ IDLE \]/);
  assert.match(box, /\[x\] Task 1: Setup database schema \(Commit: a1b2c3d\)/);
  assert.match(box, /\[>\] Task 2: Create API routes/);
  assert.match(box, /\[ \] Task 3: Implement Svelte 5 reactive stores/);
  assert.match(box, /\[ ACTIVE GOAL: Task 2 \]/);
});

test("queue task displays use only a trimmed first-line preview", () => {
  const objective = `${"x".repeat(100)}\nsecond line must stay hidden`;
  const state = appendTask(createQueueState(0), createQueueTask(objective));

  assert.equal(formatTaskPreview(objective), `${"x".repeat(57)}...`);
  assert.doesNotMatch(formatQueueStatusBox(state), /second line/);
  assert.doesNotMatch(formatQueueTaskStatusList(state), /second line/);
  assert.doesNotMatch(formatQueueStateJson(state), /second line/);
});

test("formatQueueStatusBox shows running state when queue is running", () => {
  const state = { ...createQueueState(0), runState: "running" as const };
  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);

  const box = formatQueueStatusBox(withTask);
  assert.match(box, /\[ RUNNING \]/);
  assert.doesNotMatch(box, /ACTIVE GOAL/);
});

test("formatQueueStatusBox shows paused state", () => {
  const state = { ...createQueueState(0), runState: "paused" as const };
  const box = formatQueueStatusBox(state);
  assert.match(box, /\[ PAUSED \]/);
});

test("status and live widget show commit mode and human pauses", () => {
  let state = appendTask(createQueueState(0), createPauseTask(0));
  state = setCommitSetting(state, true, 1);

  assert.match(formatQueueStatusBox(state), /Commit: ON/);
  assert.match(formatQueueStatusBox(state), /Pause 1: Pause for human/);
  assert.match(formatQueueWidgetLines(state).join("\n"), /commit on/);
  assert.match(formatQueueWidgetLines(state).join("\n"), /Pause 1/);
});

test("formatQueueFooterStatus shows an empty queue", () => {
  const state = createQueueState(0);
  assert.equal(formatQueueFooterStatus(state), "Queue empty");
});

test("formatQueueFooterStatus shows queue complete", () => {
  const state = {
    ...createQueueState(0),
    tasks: [
      { ...createQueueTask("a"), status: "complete" as const },
      { ...createQueueTask("b"), status: "complete" as const },
    ],
    runState: "idle" as const,
  };

  const footer = formatQueueFooterStatus(state);
  assert.match(footer ?? "", /Queue complete/);
});

test("formatQueueFooterStatus shows paused status", () => {
  const state = {
    ...createQueueState(0),
    tasks: [createQueueTask("a")],
    runState: "paused" as const,
  };

  const footer = formatQueueFooterStatus(state);
  assert.match(footer ?? "", /Queue paused/);
});

test("formatQueueTaskStatusList shows numbered status lines", () => {
  const state = createQueueState(0);
  const t1 = createQueueTask("First task", null, 0);
  const t2 = createQueueTask("Second task", null, 0);
  const withTasks = appendTask(appendTask(state, t1), t2);

  const list = formatQueueTaskStatusList(withTasks);
  assert.match(list, /1\. \[pending\] First task/);
  assert.match(list, /2\. \[pending\] Second task/);
});
