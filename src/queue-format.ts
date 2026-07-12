import { formatDuration, formatTokenValue } from "./format.js";
import type { QueueRunState, QueueState, QueueTask, QueueTaskStatus } from "./queue-types.js";

const BOX_WIDTH = 75;
const SEPARATOR = "-".repeat(BOX_WIDTH);
const DIVIDER = "=".repeat(BOX_WIDTH);

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

function taskSummaryLine(task: QueueTask, index: number): string {
  const marker = taskStatusMarker(task.status);
  const parts: string[] = [];

  parts.push(`  ${marker} Task ${index + 1}: ${task.objective}`);

  if (task.commitSha) {
    parts.push(` (Commit: ${task.commitSha.slice(0, 7)})`);
  }
  if (task.commitWarning) {
    parts.push(` (warning: ${task.commitWarning})`);
  }
  if (task.summary) {
    const short = task.summary.length > 50 ? `${task.summary.slice(0, 47)}...` : task.summary;
    parts.push(` // ${short}`);
  }

  return parts.join("");
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

  const active = state.tasks[state.cursor];
  if (active) {
    lines.push(SEPARATOR);
    lines.push(`  [ ACTIVE GOAL: Task ${state.cursor + 1} ]`);

    const timeStr = formatDuration(
      active.startedAt !== null ? Math.max(0, Math.floor(Date.now() / 1000) - active.startedAt) : 0,
    );

    if (active.tokenBudget !== null) {
      lines.push(`  Status:  ${active.status} (Budget: ${formatTokenValue(0)} / ${formatTokenValue(active.tokenBudget)} tokens)`);
    } else {
      lines.push(`  Status:  ${active.status}`);
    }
    lines.push(`  Time:    ${timeStr}`);
  }

  lines.push(DIVIDER);

  return lines.join("\n");
}

export function formatQueueFooterStatus(state: QueueState): string | undefined {
  if (state.tasks.length === 0) {
    return undefined;
  }

  const total = state.tasks.length;
  const completed = state.tasks.filter((t) => t.status === "complete").length;
  const skipped = state.tasks.filter((t) => t.status === "skipped").length;
  const failed = state.tasks.filter((t) => t.status === "failed").length;
  const remaining = state.tasks.filter(
    (t) => t.status === "pending" || t.status === "active",
  ).length;

  const parts: string[] = [];

  if (state.runState === "idle" && remaining === 0) {
    parts.push(`Queue complete (${completed}/${total})`);
  } else if (state.runState === "paused") {
    parts.push(`Queue paused (${completed}/${total})`);
  } else {
    parts.push(`Queue (${completed}/${total}`);
    if (skipped > 0) parts.push(`${skipped} skipped`);
    if (failed > 0) parts.push(`${failed} failed`);
    if (remaining > 0) parts.push(`${remaining} remaining`);
    parts.push(")");
    if (parts.length > 1) {
      // Flatten the parts
      const count = completed;
      const tail = parts.slice(1).join(", ");
      return `Queue ${count}/${total} (${tail})`;
    }
  }

  return parts.join(" ");
}

export function formatQueueTaskStatusList(state: QueueState): string {
  const parts: string[] = [];
  for (let i = 0; i < state.tasks.length; i++) {
    const task = state.tasks[i];
    if (!task) continue;
    parts.push(`${i + 1}. [${task.status}] ${task.objective}`);
  }
  return parts.join("\n");
}
