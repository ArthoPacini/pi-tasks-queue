import assert from "node:assert/strict";
import test from "node:test";

import {
  activeTask,
  addTask,
  advanceCursor,
  appendTask,
  clearQueue,
  createQueueState,
  createQueueTask,
  isComplete,
  markTaskComplete,
  markTaskFailed,
  markTaskStarted,
  nextPendingTask,
  pauseQueue,
  recordCommit,
  recordSummary,
  removeTask,
  resumeQueue,
  setCommitSetting,
  setSummarizeSetting,
  skipCurrentTask,
  startQueue,
  toggleCommitSetting,
  toggleSummarizeSetting,
  validateObjective,
  validateTokenBudget,
} from "../src/queue-state.js";

test("createQueueState creates empty idle queue", () => {
  const state = createQueueState(100);
  assert.equal(state.version, 1);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.cursor, 0);
  assert.equal(state.runState, "idle");
  assert.equal(state.settings.commitBetweenTasks, false);
  assert.equal(state.settings.summarizeBetweenTasks, false);
  assert.equal(state.updatedAt, 100);
});

test("validateObjective validates emptiness and length", () => {
  assert.equal(validateObjective("   "), "Objective must not be empty.");
  assert.equal(validateObjective(""), "Objective must not be empty.");
  assert.equal(validateObjective("ship it"), null);
  assert.equal(validateObjective("x".repeat(8_000)), null);
  assert.equal(validateObjective("x".repeat(8_001)), "Objective must be 8000 characters or fewer.");
});

test("validateTokenBudget validates budget", () => {
  assert.equal(validateTokenBudget(null), null);
  assert.equal(validateTokenBudget(undefined), null);
  assert.equal(validateTokenBudget(10), null);
  assert.equal(validateTokenBudget(0), "Token budget must be a positive integer.");
  assert.equal(validateTokenBudget(-1), "Token budget must be a positive integer.");
  assert.equal(validateTokenBudget(1.5), "Token budget must be a positive integer.");
});

test("addTask validates objective and budget", () => {
  const state = createQueueState(100);
  assert.equal(addTask(state, "").ok, false);
  assert.equal(addTask(state, "fine", 0).ok, false);
  assert.equal(addTask(state, "fine", 10).ok, true);
  assert.equal(addTask(state, "fine", 10).task?.objective, "fine");
  assert.equal(addTask(state, " fine ").task?.objective, "fine");
});

test("appendTask appends to tasks list", () => {
  const state = createQueueState(100);
  const task = createQueueTask("first", null, 100);
  const next = appendTask(state, task, 101);
  assert.equal(next.tasks.length, 1);
  assert.equal(next.tasks[0]?.taskId, task.taskId);
  assert.equal(next.updatedAt, 101);
});

test("removeTask removes pending tasks and adjusts cursor", () => {
  const state = createQueueState(100);
  const t1 = createQueueTask("task1", null, 100);
  const t2 = createQueueTask("task2", null, 100);
  const t3 = createQueueTask("task3", null, 100);
  const withTasks = appendTask(appendTask(appendTask(state, t1, 101), t2, 102), t3, 103);

  // Remove middle task (index 1) with cursor at 0
  const result = removeTask(withTasks, 1, 104);
  assert.ok(result.ok);
  assert.equal(result.state?.tasks.length, 2);
  assert.equal(result.state?.tasks[0]?.taskId, t1.taskId);
  assert.equal(result.state?.tasks[1]?.taskId, t3.taskId);
  assert.equal(result.state?.cursor, 0);

  // Remove from index 0 with cursor at 1 => cursor adjusts down
  const state2 = withTasks;
  const withCursor1 = { ...state2, cursor: 2 };
  const result2 = removeTask(withCursor1, 0, 105);
  assert.ok(result2.ok);
  assert.equal(result2.state?.cursor, 1);
});

test("removeTask rejects active and complete tasks", () => {
  const state = createQueueState(100);
  const t1 = createQueueTask("task1", null, 100);
  const started = markTaskStarted(appendTask(state, t1, 101), "s1", 102);
  assert.ok(started.ok);
  assert.equal(removeTask(started.state!, 0, 103).ok, false);

  const completed = markTaskComplete(started.state!, 104);
  assert.ok(completed.ok);
  assert.equal(removeTask(completed.state!, 0, 105).ok, false);
});

test("removeTask rejects out-of-range index", () => {
  const state = createQueueState(100);
  assert.equal(removeTask(state, 0, 101).ok, false);
  assert.equal(removeTask(state, -1, 101).ok, false);
});

test("activeTask returns current cursor task", () => {
  const state = createQueueState(100);
  assert.equal(activeTask(state), null);

  const t1 = createQueueTask("task1");
  const t2 = createQueueTask("task2");
  const withTasks = appendTask(appendTask(state, t1), t2);
  assert.equal(activeTask(withTasks)?.taskId, t1.taskId);

  const atCursor1 = { ...withTasks, cursor: 1 };
  assert.equal(activeTask(atCursor1)?.taskId, t2.taskId);
});

test("nextPendingTask finds next pending after cursor", () => {
  const state = createQueueState(0);
  const t1 = createQueueTask("task1");
  const t2 = createQueueTask("task2");
  const t3 = createQueueTask("task3");
  const withTasks = appendTask(appendTask(appendTask(state, t1), t2), t3);

  // All pending, cursor 0 => task 1
  assert.equal(nextPendingTask(withTasks)?.taskId, t1.taskId);

  // Cursor past end => null
  const pastEnd = { ...withTasks, cursor: 3 };
  assert.equal(nextPendingTask(pastEnd), null);
});

test("advanceCursor moves to next pending task or goes idle", () => {
  const state = createQueueState(0);
  const t1 = createQueueTask("task1");
  const t2 = createQueueTask("task2");
  const withTasks = appendTask(appendTask(state, t1), t2);

  // Cursor 0, advance to 1
  const { state: nextState, advanced } = advanceCursor(withTasks, 10);
  assert.equal(advanced, true);
  assert.equal(nextState.cursor, 1);

  // Cursor 1, no more pending => idle
  const { state: finalState, advanced: noMore } = advanceCursor(nextState, 20);
  assert.equal(noMore, false);
  assert.equal(finalState.runState, "idle");
  assert.equal(finalState.cursor, 2);
});

test("advanceCursor skips non-pending tasks", () => {
  const state = createQueueState(0);
  const t1 = createQueueTask("task1");
  const t2 = createQueueTask("task2");
  const t3 = createQueueTask("task3");
  const withTasks = appendTask(appendTask(appendTask(state, t1), t2), t3);
  const skippedT2 = {
    ...withTasks,
    tasks: withTasks.tasks.map((t, i) => (i === 1 ? { ...t, status: "skipped" as const } : t)),
    cursor: 0,
  };

  const { state: nextState, advanced } = advanceCursor(skippedT2, 10);
  assert.equal(advanced, true);
  assert.equal(nextState.cursor, 2);
  assert.equal(nextState.tasks[2]?.taskId, t3.taskId);
});

test("markTaskStarted requires pending status", () => {
  const state = createQueueState(0);
  assert.equal(markTaskStarted(state, "s1", 1).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);

  // Start the task
  const started = markTaskStarted(withTask, "s1", 1);
  assert.ok(started.ok);
  assert.equal(started.state?.tasks[0]?.status, "active");
  assert.equal(started.state?.tasks[0]?.startedAt, 1);
  assert.equal(started.state?.tasks[0]?.sessionId, "s1");

  // Can't start again
  assert.equal(markTaskStarted(started.state!, "s2", 2).ok, false);
});

test("markTaskComplete requires active status", () => {
  const state = createQueueState(0);
  assert.equal(markTaskComplete(state).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);
  assert.equal(markTaskComplete(withTask).ok, false);

  const started = markTaskStarted(withTask, "s1", 1);
  assert.ok(started.ok);

  const completed = markTaskComplete(started.state!, 2);
  assert.ok(completed.ok);
  assert.equal(completed.state?.tasks[0]?.status, "complete");
  assert.equal(completed.state?.tasks[0]?.completedAt, 2);
});

test("markTaskFailed requires active status", () => {
  const state = createQueueState(0);
  assert.equal(markTaskFailed(state).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);
  const started = markTaskStarted(withTask, "s1", 1);
  assert.ok(started.ok);

  const failed = markTaskFailed(started.state!, 2);
  assert.ok(failed.ok);
  assert.equal(failed.state?.tasks[0]?.status, "failed");
  assert.equal(failed.state?.tasks[0]?.completedAt, 2);
});

test("skipCurrentTask handles various states", () => {
  const state = createQueueState(0);
  assert.equal(skipCurrentTask(state).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);

  // Skip pending task
  const skipped = skipCurrentTask(withTask, 1);
  assert.ok(skipped.ok);
  assert.equal(skipped.state?.tasks[0]?.status, "skipped");
  assert.equal(skipped.state?.tasks[0]?.completedAt, 1);
});

test("recordCommit records sha and warning on active task", () => {
  const state = createQueueState(0);
  assert.equal(recordCommit(state, "abc", null, 1).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);
  const started = markTaskStarted(withTask, "s1", 1);
  assert.ok(started.ok);

  const recorded = recordCommit(started.state!, "abc123", null, 2);
  assert.ok(recorded.ok);
  assert.equal(recorded.state?.tasks[0]?.commitSha, "abc123");
  assert.equal(recorded.state?.tasks[0]?.commitWarning, null);

  const warning = recordCommit(started.state!, null, "commit failed", 3);
  assert.ok(warning.ok);
  assert.equal(warning.state?.tasks[0]?.commitSha, null);
  assert.equal(warning.state?.tasks[0]?.commitWarning, "commit failed");
});

test("recordSummary records summary on active task", () => {
  const state = createQueueState(0);
  assert.equal(recordSummary(state, "summary text", 1).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);
  const started = markTaskStarted(withTask, "s1", 1);
  assert.ok(started.ok);

  const result = recordSummary(started.state!, "Did X and Y", 2);
  assert.ok(result.ok);
  assert.equal(result.state?.tasks[0]?.summary, "Did X and Y");
});

test("toggleCommitSetting and toggleSummarizeSetting toggle values", () => {
  const state = createQueueState(0);
  const toggled = toggleCommitSetting(state, 1);
  assert.equal(toggled.settings.commitBetweenTasks, true);
  assert.equal(toggled.updatedAt, 1);

  const toggledBack = toggleCommitSetting(toggled, 2);
  assert.equal(toggledBack.settings.commitBetweenTasks, false);

  const sumToggled = toggleSummarizeSetting(state, 3);
  assert.equal(sumToggled.settings.summarizeBetweenTasks, true);
});

test("setCommitSetting and setSummarizeSetting set explicit values", () => {
  const state = createQueueState(0);
  const setOn = setCommitSetting(state, true, 1);
  assert.equal(setOn.settings.commitBetweenTasks, true);
  const setOff = setCommitSetting(setOn, false, 2);
  assert.equal(setOff.settings.commitBetweenTasks, false);

  const sumOn = setSummarizeSetting(state, true, 3);
  assert.equal(sumOn.settings.summarizeBetweenTasks, true);
});

test("startQueue validates run state and pending tasks", () => {
  const state = createQueueState(0);
  const runningState = { ...state, runState: "running" as const };
  assert.equal(startQueue(runningState).ok, false);

  const idleEmpty = createQueueState(0);
  assert.equal(startQueue(idleEmpty).ok, false);

  const t1 = createQueueTask("task1");
  const withTask = appendTask(idleEmpty, t1);
  const result = startQueue(withTask, 1);
  assert.ok(result.ok);
});

test("pauseQueue requires running state", () => {
  const state = createQueueState(0);
  assert.equal(pauseQueue(state).ok, false);

  const runningState = { ...state, runState: "running" as const };
  const paused = pauseQueue(runningState, 1);
  assert.ok(paused.ok);
  assert.equal(paused.state?.runState, "paused");
});

test("resumeQueue requires paused state", () => {
  const state = createQueueState(0);
  assert.equal(resumeQueue(state).ok, false);

  const pausedState = { ...state, runState: "paused" as const };
  const resumed = resumeQueue(pausedState, 1);
  assert.ok(resumed.ok);
  assert.equal(resumed.state?.runState, "running");
});

test("clearQueue resets tasks and cursor", () => {
  const state = createQueueState(0);
  const t1 = createQueueTask("task1");
  const t2 = createQueueTask("task2");
  const withTasks = appendTask(appendTask(state, t1), t2);
  const runningState = { ...withTasks, runState: "running" as const, cursor: 1 };

  const cleared = clearQueue(runningState, 2);
  assert.deepEqual(cleared.tasks, []);
  assert.equal(cleared.cursor, 0);
  assert.equal(cleared.runState, "idle");
  assert.equal(cleared.updatedAt, 2);
});

test("isComplete checks all tasks terminal", () => {
  const state = createQueueState(0);
  // Empty queue is trivially complete
  assert.equal(isComplete(state), true);

  // Pending task => not complete
  const t1 = createQueueTask("task1");
  const withTask = appendTask(state, t1);
  assert.equal(isComplete(withTask), false);

  // Build a state with all terminal statuses directly
  const tA = createQueueTask("a");
  const tB = createQueueTask("b");
  const tC = createQueueTask("c");
  const allComplete = {
    ...state,
    tasks: [
      { ...tA, status: "complete" as const },
      { ...tB, status: "skipped" as const },
      { ...tC, status: "failed" as const },
    ],
  };
  assert.equal(isComplete(allComplete), true);

  // One pending mixed in => not complete
  const tD = createQueueTask("d");
  const onePending = {
    ...allComplete,
    tasks: [...allComplete.tasks, { ...tD, status: "pending" as const }],
  };
  assert.equal(isComplete(onePending), false);

  // Active task => not complete
  const oneActive = {
    ...allComplete,
    tasks: [...allComplete.tasks, { ...tD, status: "active" as const }],
  };
  assert.equal(isComplete(oneActive), false);
});

test("advanceCursor handles empty queue", () => {
  const state = createQueueState(0);
  const { state: next, advanced } = advanceCursor(state, 1);
  assert.equal(advanced, false);
  assert.equal(next.runState, "idle");
});

test("multiple tasks advance through full lifecycle", () => {
  let state = createQueueState(0);

  // Add 3 tasks
  const t1 = createQueueTask("first", null, 0);
  const t2 = createQueueTask("second", null, 0);
  const t3 = createQueueTask("third", null, 0);
  state = appendTask(state, t1, 1);
  state = appendTask(state, t2, 2);
  state = appendTask(state, t3, 3);

  // Start task 1
  const started1 = markTaskStarted(state, "s1", 4);
  assert.ok(started1.ok);
  state = started1.state!;

  // Complete task 1
  const completed1 = markTaskComplete(state, 5);
  assert.ok(completed1.ok);
  state = completed1.state!;

  // Advance to task 2
  const adv1 = advanceCursor(state, 6);
  assert.equal(adv1.advanced, true);
  state = adv1.state;
  assert.equal(state.cursor, 1);

  // Start task 2
  const started2 = markTaskStarted(state, "s2", 7);
  assert.ok(started2.ok);
  state = started2.state!;

  // Skip task 2
  const skipped2 = skipCurrentTask(state, 8);
  assert.ok(skipped2.ok);
  state = skipped2.state!;

  // Advance to task 3
  const adv2 = advanceCursor(state, 9);
  assert.equal(adv2.advanced, true);
  state = adv2.state;
  assert.equal(state.cursor, 2);

  // Start and complete task 3
  const started3 = markTaskStarted(state, "s3", 10);
  assert.ok(started3.ok);
  state = started3.state!;
  const completed3 = markTaskComplete(state, 11);
  assert.ok(completed3.ok);
  state = completed3.state!;

  // Advance from last => idle
  const adv3 = advanceCursor(state, 12);
  assert.equal(adv3.advanced, false);
  assert.equal(adv3.state.runState, "idle");
  assert.equal(adv3.state.cursor, 3);
});
