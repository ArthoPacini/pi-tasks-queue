import { formatCompactTokenValue, formatDuration } from "./format.js";
import type { QueueRunState, QueueState, QueueTask, QueueTaskStatus } from "./queue-types.js";

const BOX_WIDTH = 75;
const TASK_PREVIEW_CHARS = 60;
const SEPARATOR = "-".repeat(BOX_WIDTH);
const DIVIDER = "=".repeat(BOX_WIDTH);

export function formatTaskPreview(text: string, maxLength = TASK_PREVIEW_CHARS): string {
  const firstLine = text.split(/\r?\n|\r/, 1)[0]?.trim() ?? "";
  return firstLine.length > maxLength
    ? `${firstLine.slice(0, Math.max(0, maxLength - 3))}...`
    : firstLine;
}

function runStateLabel(runState: QueueRunState): string {
  switch (runState) {
    case "idle":
      return "IDLE";
    case "running":
      return "RUNNING";
    case "paused":
      return "PAUSED";
  }
}

function taskStatusMarker(status: QueueTaskStatus): string {
  switch (status) {
    case "complete":
      return "[x]";
    case "active":
      return "[>]";
    case "pending":
      return "[ ]";
    case "failed":
      return "[!]";
    case "skipped":
      return "[-]";
  }
}

function taskDuration(task: QueueTask): string {
  if (task.status !== "complete" && task.status !== "failed" && task.status !== "skipped") {
    return "";
  }
  if (task.startedAt === null || task.completedAt === null) {
    return "";
  }
  return formatDuration(Math.max(0, task.completedAt - task.startedAt));
}

function taskTokens(task: QueueTask): string {
  if (task.tokensUsed <= 0) {
    return "";
  }
  return formatCompactTokenValue(task.tokensUsed);
}

function taskSummaryLine(task: QueueTask, index: number): string {
  const marker = taskStatusMarker(task.status);
  const duration = taskDuration(task);
  const tokens = taskTokens(task);

  let meta = "";
  if (duration && tokens) {
    meta = ` (${duration}, ${tokens})`;
  } else if (duration) {
    meta = ` (${duration})`;
  } else if (tokens) {
    meta = ` (${tokens})`;
  }

  let line = `  ${marker} Task ${index + 1}${meta}: ${formatTaskPreview(task.objective)}`;

  if (task.commitSha) {
    line += ` (Commit: ${task.commitSha.slice(0, 7)})`;
  }
  if (task.commitWarning) {
    line += ` (warning: ${formatTaskPreview(task.commitWarning, 50)})`;
  }
  if (task.summary) {
    line += ` // ${formatTaskPreview(task.summary, 50)}`;
  }

  return line;
}

function totalDuration(state: QueueState): string {
  let total = 0;
  for (const task of state.tasks) {
    if (task.startedAt !== null && task.completedAt !== null) {
      total += task.completedAt - task.startedAt;
    }
  }
  return formatDuration(total);
}

function totalTokens(state: QueueState): number {
  let total = 0;
  for (const task of state.tasks) {
    total += task.tokensUsed;
  }
  return total;
}

export function formatQueueStatusBox(state: QueueState): string {
  const lines: string[] = [];
  const runLabel = runStateLabel(state.runState);

  lines.push(DIVIDER);
  lines.push(`  PI-QUEUE ORCHESTRATOR${" ".repeat(BOX_WIDTH - 26 - runLabel.length)}[ ${runLabel} ]`);
  lines.push(DIVIDER);

  lines.push("  [ QUEUE STATE ]");

  if (state.tasks.length === 0) {
    lines.push("  (no tasks)");
  } else {
    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i];
      if (task) {
        lines.push(taskSummaryLine(task, i));
      }
    }
  }

  // Active goal section
  const active = state.tasks[state.cursor];
  if (active?.status === "active") {
    lines.push(SEPARATOR);
    lines.push(`  [ ACTIVE GOAL: Task ${state.cursor + 1} ]`);

    const timeStr = formatDuration(
      active.startedAt !== null ? Math.max(0, Math.floor(Date.now() / 1000) - active.startedAt) : 0,
    );

    lines.push(`  Status:  ${active.status}`);
    lines.push(`  Time:    ${timeStr}`);
  }

  // Totals row (show even when idle/running)
  if (state.tasks.length > 0) {
    const completeCount = state.tasks.filter((t) => t.status === "complete" || t.status === "failed" || t.status === "skipped").length;
    if (completeCount > 0) {
      lines.push(SEPARATOR);
      lines.push(`  Total Time: ${totalDuration(state)}${" ".repeat(Math.max(1, BOX_WIDTH - 52 - totalDuration(state).length))}Total Tokens: ${formatCompactTokenValue(totalTokens(state))}`);
    }
  }

  lines.push(DIVIDER);

  return lines.join("\n");
}

export function formatQueueFooterStatus(state: QueueState): string {
  if (state.tasks.length === 0) {
    return "Queue empty";
  }

  const total = state.tasks.length;
  const completed = state.tasks.filter((t) => t.status === "complete").length;
  const skipped = state.tasks.filter((t) => t.status === "skipped").length;
  const failed = state.tasks.filter((t) => t.status === "failed").length;
  const remaining = state.tasks.filter(
    (t) => t.status === "pending" || t.status === "active",
  ).length;

  if (state.runState === "idle" && remaining === 0) {
    return `Queue complete (${completed}/${total})`;
  }
  if (state.runState === "paused") {
    return `Queue paused (${completed}/${total})`;
  }
  // Running or idle with remaining
  const parts = [`Queue ${completed}/${total}`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (remaining > 0) parts.push(`${remaining} remaining`);
  return parts.join(", ");
}

export function formatQueueStateJson(state: QueueState): string {
  return JSON.stringify({
    ...state,
    tasks: state.tasks.map((task) => ({ ...task, objective: formatTaskPreview(task.objective) })),
  }, null, 2);
}

export function formatQueueTaskStatusList(state: QueueState): string {
  const parts: string[] = [];
  for (let i = 0; i < state.tasks.length; i++) {
    const task = state.tasks[i];
    if (!task) continue;
    parts.push(`${i + 1}. [${task.status}] ${formatTaskPreview(task.objective)}`);
  }
  return parts.join("\n");
}
