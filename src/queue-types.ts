export const QUEUE_CUSTOM_ENTRY_TYPE = "pi-queue";

/** Private /queue subcommand used to obtain a command context for session replacement. */
export const QUEUE_NEW_SESSION_SUBCOMMAND = "__start-next-session";

export const MAX_OBJECTIVE_CHARS = 8000;

export type QueueTaskStatus = "pending" | "active" | "complete" | "failed" | "skipped";
export type QueueTaskKind = "task" | "pause";

export interface QueueTask {
  taskId: string;
  kind: QueueTaskKind;
  objective: string;
  tokenBudget: number | null;
  status: QueueTaskStatus;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  sessionId: string | null;
  commitSha: string | null;
  commitWarning: string | null;
  summary: string | null;
  tokensUsed: number;
}

export interface QueueSettings {
  commitBetweenTasks: boolean;
  summarizeBetweenTasks: boolean;
  showStatusWidget: boolean;
}

export type QueueRunState = "idle" | "running" | "paused";

export interface QueueState {
  version: 1;
  revision: number;
  tasks: QueueTask[];
  cursor: number;
  settings: QueueSettings;
  runState: QueueRunState;
  updatedAt: number;
}

export interface QueueResult {
  ok: boolean;
  message: string;
}

export interface QueueTaskResult extends QueueResult {
  task: QueueTask | null;
  state?: QueueState;
}

export interface QueueStateResult extends QueueResult {
  state: QueueState | null;
}
