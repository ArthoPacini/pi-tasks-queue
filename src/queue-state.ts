import { randomUUID } from "node:crypto";

import type {
  QueueResult,
  QueueRunState,
  QueueSettings,
  QueueState,
  QueueStateResult,
  QueueTask,
  QueueTaskResult,
} from "./queue-types.js";
import { MAX_OBJECTIVE_CHARS } from "./queue-types.js";

export function unixSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function bumpRevision(state: QueueState, now = unixSeconds()): QueueState {
  return { ...state, revision: state.revision + 1, updatedAt: now };
}

export function validateObjective(objective: string): string | null {
  const trimmed = objective.trim();
  if (trimmed.length === 0) {
    return "Objective must not be empty.";
  }
  if ([...trimmed].length > MAX_OBJECTIVE_CHARS) {
    return `Objective must be ${MAX_OBJECTIVE_CHARS} characters or fewer.`;
  }
  return null;
}

export function validateTokenBudget(tokenBudget: number | null | undefined): string | null {
  if (tokenBudget === null || tokenBudget === undefined) {
    return null;
  }
  if (!Number.isInteger(tokenBudget) || tokenBudget <= 0) {
    return "Token budget must be a positive integer.";
  }
  return null;
}

export function createQueueState(now = unixSeconds()): QueueState {
  return {
    version: 1,
    revision: 0,
    tasks: [],
    cursor: 0,
    settings: { commitBetweenTasks: false, summarizeBetweenTasks: false },
    runState: "idle",
    updatedAt: now,
  };
}

export function createQueueTask(
  objective: string,
  tokenBudget: number | null = null,
  now = unixSeconds(),
): QueueTask {
  return {
    taskId: randomUUID(),
    objective: objective.trim(),
    tokenBudget,
    status: "pending",
    createdAt: now,
    startedAt: null,
    completedAt: null,
    sessionId: null,
    commitSha: null,
    commitWarning: null,
    summary: null,
    tokensUsed: 0,
  };
}

export function addTask(
  state: QueueState,
  objective: string,
  tokenBudget: number | null = null,
  now = unixSeconds(),
): QueueTaskResult {
  const objectiveError = validateObjective(objective);
  if (objectiveError) {
    return { ok: false, message: objectiveError, task: null };
  }

  const budgetError = validateTokenBudget(tokenBudget);
  if (budgetError) {
    return { ok: false, message: budgetError, task: null };
  }

  const task = createQueueTask(objective, tokenBudget, now);
  return {
    ok: true,
    message: "Task added.",
    task,
  };
}

export function appendTask(
  state: QueueState,
  task: QueueTask,
  now = unixSeconds(),
): QueueState {
  return bumpRevision(
    {
      ...state,
      tasks: [...state.tasks, task],
    },
    now,
  );
}

export function removeTask(state: QueueState, index: number, now = unixSeconds()): QueueTaskResult {
  if (index < 0 || index >= state.tasks.length) {
    return { ok: false, message: "Task index out of range.", task: null };
  }

  const task = state.tasks[index];
  if (!task) {
    return { ok: false, message: "Task not found.", task: null };
  }

  if (task.status === "active") {
    return { ok: false, message: "Cannot remove the active task.", task: null };
  }

  if (task.status === "complete") {
    return { ok: false, message: "Cannot remove a completed task.", task: null };
  }

  const nextTasks = [...state.tasks];
  nextTasks.splice(index, 1);

  const nextCursor = index < state.cursor ? state.cursor - 1 : state.cursor;

  return {
    ok: true,
    message: "Task removed.",
    task,
    state: bumpRevision(
      {
        ...state,
        tasks: nextTasks,
        cursor: Math.max(0, Math.min(nextCursor, nextTasks.length)),
      } as QueueState,
      now,
    ),
  };
}

export function activeTask(state: QueueState): QueueTask | null {
  if (state.cursor < 0 || state.cursor >= state.tasks.length) {
    return null;
  }
  return state.tasks[state.cursor] ?? null;
}

export function nextPendingTask(state: QueueState): QueueTask | null {
  for (let i = state.cursor; i < state.tasks.length; i++) {
    const task = state.tasks[i];
    if (task && task.status === "pending") {
      return task;
    }
  }
  return null;
}

export function advanceCursor(state: QueueState, now = unixSeconds()): { state: QueueState; advanced: boolean } {
  const nextIndex = state.tasks.findIndex(
    (task, i) => i > state.cursor && task.status === "pending",
  );

  if (nextIndex === -1) {
    return {
      state: bumpRevision(
        { ...state, cursor: state.tasks.length, runState: "idle" },
        now,
      ),
      advanced: false,
    };
  }

  return {
    state: bumpRevision({ ...state, cursor: nextIndex }, now),
    advanced: true,
  };
}

export function markTaskStarted(
  state: QueueState,
  sessionId: string,
  now = unixSeconds(),
): QueueStateResult {
  const task = activeTask(state);
  if (!task) {
    return { ok: false, message: "No active task to start.", state: null };
  }
  if (task.status !== "pending") {
    return {
      ok: false,
      message: `Cannot start task with status ${task.status}.`,
      state: null,
    };
  }

  const nextTasks = state.tasks.map((t) =>
    t.taskId === task.taskId
      ? { ...t, status: "active" as const, startedAt: now, sessionId }
      : t,
  );

  return {
    ok: true,
    message: "Task started.",
    state: bumpRevision({ ...state, tasks: nextTasks }, now),
  };
}

export function markTaskComplete(state: QueueState, options: { tokensUsed?: number; now?: number } = {}): QueueStateResult {
  const now = options.now ?? unixSeconds();
  const task = activeTask(state);
  if (!task) {
    return { ok: false, message: "No active task to complete.", state: null };
  }
  if (task.status !== "active") {
    return {
      ok: false,
      message: `Cannot complete task with status ${task.status}.`,
      state: null,
    };
  }

  const nextTasks = state.tasks.map((t) =>
    t.taskId === task.taskId
      ? { ...t, status: "complete" as const, completedAt: now, tokensUsed: options.tokensUsed ?? t.tokensUsed }
      : t,
  );

  return {
    ok: true,
    message: "Task completed.",
    state: bumpRevision({ ...state, tasks: nextTasks }, now),
  };
}

export function markTaskFailed(state: QueueState, now = unixSeconds()): QueueStateResult {
  const task = activeTask(state);
  if (!task) {
    return { ok: false, message: "No active task to fail.", state: null };
  }
  if (task.status !== "active") {
    return {
      ok: false,
      message: `Cannot fail task with status ${task.status}.`,
      state: null,
    };
  }

  const nextTasks = state.tasks.map((t) =>
    t.taskId === task.taskId
      ? { ...t, status: "failed" as const, completedAt: now }
      : t,
  );

  return {
    ok: true,
    message: "Task failed.",
    state: bumpRevision({ ...state, tasks: nextTasks }, now),
  };
}

export function skipCurrentTask(state: QueueState, now = unixSeconds()): QueueStateResult {
  const task = activeTask(state);
  if (!task) {
    return { ok: false, message: "No active task to skip.", state: null };
  }

  const nextTasks = state.tasks.map((t) =>
    t.taskId === task.taskId
      ? { ...t, status: "skipped" as const, completedAt: now }
      : t,
  );

  return {
    ok: true,
    message: "Task skipped.",
    state: bumpRevision({ ...state, tasks: nextTasks }, now),
  };
}

export function recordCommit(
  state: QueueState,
  sha: string | null,
  warning: string | null,
  now = unixSeconds(),
): QueueStateResult {
  const task = activeTask(state);
  if (!task) {
    return { ok: false, message: "No active task.", state: null };
  }

  const nextTasks = state.tasks.map((t) =>
    t.taskId === task.taskId ? { ...t, commitSha: sha, commitWarning: warning } : t,
  );

  return {
    ok: true,
    message: "Commit recorded.",
    state: bumpRevision({ ...state, tasks: nextTasks }, now),
  };
}

export function recordSummary(
  state: QueueState,
  summary: string,
  now = unixSeconds(),
): QueueStateResult {
  const task = activeTask(state);
  if (!task) {
    return { ok: false, message: "No active task.", state: null };
  }

  const nextTasks = state.tasks.map((t) =>
    t.taskId === task.taskId ? { ...t, summary } : t,
  );

  return {
    ok: true,
    message: "Summary recorded.",
    state: bumpRevision({ ...state, tasks: nextTasks }, now),
  };
}

export function toggleCommitSetting(state: QueueState, now = unixSeconds()): QueueState {
  return bumpRevision(
    {
      ...state,
      settings: { ...state.settings, commitBetweenTasks: !state.settings.commitBetweenTasks },
    },
    now,
  );
}

export function setCommitSetting(state: QueueState, value: boolean, now = unixSeconds()): QueueState {
  return bumpRevision(
    { ...state, settings: { ...state.settings, commitBetweenTasks: value } },
    now,
  );
}

export function toggleSummarizeSetting(state: QueueState, now = unixSeconds()): QueueState {
  return bumpRevision(
    {
      ...state,
      settings: { ...state.settings, summarizeBetweenTasks: !state.settings.summarizeBetweenTasks },
    },
    now,
  );
}

export function setSummarizeSetting(state: QueueState, value: boolean, now = unixSeconds()): QueueState {
  return bumpRevision(
    { ...state, settings: { ...state.settings, summarizeBetweenTasks: value } },
    now,
  );
}

export function startQueue(state: QueueState, now = unixSeconds()): QueueResult {
  if (state.runState === "running") {
    return { ok: false, message: "Queue is already running." };
  }

  const pending = state.tasks.some((t) => t.status === "pending");
  if (!pending) {
    return { ok: false, message: "No pending tasks to run." };
  }

  return { ok: true, message: "Queue started." };
}

export function pauseQueue(state: QueueState, now = unixSeconds()): QueueStateResult {
  if (state.runState !== "running") {
    return { ok: false, message: "Queue is not running.", state: null };
  }

  return {
    ok: true,
    message: "Queue paused.",
    state: bumpRevision({ ...state, runState: "paused" }, now),
  };
}

export function resumeQueue(state: QueueState, now = unixSeconds()): QueueStateResult {
  if (state.runState !== "paused") {
    return { ok: false, message: "Queue is not paused.", state: null };
  }

  return {
    ok: true,
    message: "Queue resumed.",
    state: bumpRevision({ ...state, runState: "running" }, now),
  };
}

export function setRunState(state: QueueState, runState: QueueRunState, now = unixSeconds()): QueueState {
  return bumpRevision({ ...state, runState }, now);
}

export function clearQueue(state: QueueState, now = unixSeconds()): QueueState {
  return bumpRevision(
    { ...state, tasks: [], cursor: 0, runState: "idle" },
    now,
  );
}

export function isComplete(state: QueueState): boolean {
  return state.tasks.every((t) => t.status === "complete" || t.status === "skipped" || t.status === "failed");
}
