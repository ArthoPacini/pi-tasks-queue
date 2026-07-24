import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createQueuePersistence } from "./queue-persistence.js";
import type { QueueState, QueueStateResult } from "./queue-types.js";
import { QUEUE_CUSTOM_ENTRY_TYPE } from "./queue-types.js";
import {
  advanceCursor,
  markTaskComplete,
  markTaskStarted,
  pauseQueue,
  recordCommit,
  recordSummary,
  resumeQueue,
  setRunState,
  skipCurrentTask,
} from "./queue-state.js";
import type { GoalRuntimeController } from "./goal-runtime-controller.js";
import type { StatusContext } from "./goal-runtime-status.js";
import { type GitCommitResult, commitTaskWork, type ExecFunction } from "./queue-git.js";
import { formatQueueFooterStatus, formatQueueWidgetLines } from "./queue-format.js";
import { captureSummary, formatPriorContext } from "./queue-summarize.js";
import { replaceGoal } from "./state.js";
import { continuationPrompt } from "./prompts.js";
import { CUSTOM_ENTRY_TYPE } from "./types.js";

interface QueueUiContext extends StatusContext {
  ui: StatusContext["ui"] & Pick<ExtensionContext["ui"], "setWidget">;
}

interface QueueRuntimeControllerDeps {
  pi: ExtensionAPI;
  goalController: GoalRuntimeController;
  projectRoot: string;
}

export interface QueueRuntimeController {
  /** Read-only snapshot of current queue state. */
  getQueueState(): QueueState;
  /** Apply a pure-state transformation to the in-memory queue state. */
  updateQueueState(transform: (state: QueueState) => QueueState): QueueState;
  /** Persist current state to disk. */
  persistQueueState(): void;
  /** Refresh the queue footer and optional live widget. */
  refreshUi(ctx: QueueUiContext): void;
  /** Set runState to "running" and immediately kick off the active task. */
  start(ctx: ExtensionContext): void;
  /** Resume and immediately kick off the next pending task, if any. */
  resume(ctx: ExtensionContext): QueueStateResult;
  /** Skip the current task and advance the queue. */
  skip(ctx: ExtensionContext): QueueStateResult;
}

export function createQueueRuntimeController(deps: QueueRuntimeControllerDeps): QueueRuntimeController {
  const persistence = createQueuePersistence({ projectRoot: deps.projectRoot });
  let queueState: QueueState;

  const exec: ExecFunction = async (command: string, args?: string[]) => {
    const result = await deps.pi.exec(command, args ?? [], { cwd: deps.projectRoot });
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
      killed: result.killed ?? false,
    };
  };

  const loadState = (): void => {
    queueState = persistence.load();
  };

  const appendAuditEntry = (kind: string, data: unknown): void => {
    deps.pi.appendEntry(QUEUE_CUSTOM_ENTRY_TYPE, { kind, data, at: Date.now() });
  };

  const persistQueueState = (): void => {
    persistence.save(queueState);
  };

  const updateQueueState = (transform: (state: QueueState) => QueueState): QueueState => {
    queueState = transform(queueState);
    return queueState;
  };

  const refreshUi = (ctx: QueueUiContext): void => {
    try {
      ctx.ui.setStatus("pi-queue", formatQueueFooterStatus(queueState));
      ctx.ui.setWidget(
        "pi-queue-status",
        queueState.settings.showStatusWidget ? formatQueueWidgetLines(queueState) : undefined,
      );
    } catch {
      // Ignore UI errors
    }
  };

  loadState();

  /** Queue a continuation turn for the active goal. */
  const queueGoalTurn = (ctx: ExtensionContext): void => {
    const goal = deps.goalController.getGoalForDisplay();
    if (!goal || goal.status !== "active") {
      return;
    }

    deps.pi.sendMessage(
      {
        customType: CUSTOM_ENTRY_TYPE,
        content: continuationPrompt(goal),
        display: false,
        details: { kind: "command_start", goalId: goal.goalId },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  /**
   * Set runState to "running" and kick off the active task immediately.
   */
  const start = (ctx: ExtensionContext): void => {
    queueState = setRunState(queueState, "running");
    startKickoff(ctx);
    refreshUi(ctx);
  };

  const resume = (ctx: ExtensionContext): QueueStateResult => {
    const result = resumeQueue(queueState);
    if (!result.ok || !result.state) {
      return result;
    }

    queueState = result.state;
    const waitingPause = queueState.tasks[queueState.cursor];
    if (waitingPause?.kind === "pause" && waitingPause.status === "active") {
      const completed = markTaskComplete(queueState);
      if (!completed.ok || !completed.state) {
        return completed;
      }
      queueState = completed.state;
      appendAuditEntry("human_pause_resumed", { taskId: waitingPause.taskId, cursor: queueState.cursor });
      queueState = advanceCursor(queueState).state;
    } else {
      const goal = deps.goalController.getGoalForDisplay();
      if (goal?.status === "paused") {
        const resumedGoal = deps.goalController.resumeGoalWithContinuation(goal.goalId, "runtime", ctx);
        if (!resumedGoal.ok) {
          return { ok: false, message: resumedGoal.message, state: null };
        }
      }
    }

    startKickoff(ctx);
    persistQueueState();
    refreshUi(ctx);
    return { ...result, state: queueState };
  };

  const skip = (ctx: ExtensionContext): QueueStateResult => {
    const skippedTask = queueState.tasks[queueState.cursor];
    const skippedAgentTaskWasActive = skippedTask?.status === "active" && skippedTask.kind === "task";
    const skippedHumanPause = skippedTask?.status === "active" && skippedTask.kind === "pause";
    const result = skipCurrentTask(queueState);
    if (!result.ok || !result.state) {
      return result;
    }
    queueState = result.state;

    if (skippedAgentTaskWasActive) {
      deps.goalController.clearGoal("runtime", ctx);
    }
    if (skippedHumanPause) {
      queueState = setRunState(queueState, "running");
    }

    queueState = advanceCursor(queueState).state;
    persistQueueState();
    startKickoff(ctx);
    refreshUi(ctx);
    return { ...result, state: queueState };
  };

  /** Kick off the active task when runState is running. */
  const startKickoff = (ctx: ExtensionContext): void => {
    if (queueState.runState !== "running") {
      return;
    }
    const goal = deps.goalController.getGoalForDisplay();

    const activeTask = queueState.tasks[queueState.cursor];
    const restoringActiveTask = activeTask?.status === "active" && !goal;
    if (goal && goal.status !== "complete") {
      if (activeTask && goal.objective.startsWith(activeTask.objective)) {
        return;
      }
      return;
    }

    // Advance cursor past terminal tasks
    if (activeTask && (activeTask.status === "complete" || activeTask.status === "skipped" || activeTask.status === "failed")) {
      const { state, advanced } = advanceCursor(queueState);
      if (!advanced) {
        queueState = setRunState(state, "idle");
        persistQueueState();
        refreshUi(ctx);
        return;
      }
      queueState = state;
    }

    const task = queueState.tasks[queueState.cursor];
    if (!task || (task.status !== "pending" && !restoringActiveTask)) {
      return;
    }

    if (task.kind === "pause") {
      if (!restoringActiveTask) {
        const started = markTaskStarted(queueState, "human-pause");
        if (!started.ok || !started.state) {
          return;
        }
        queueState = started.state;
      }
      queueState = setRunState(queueState, "paused");
      appendAuditEntry("human_pause_reached", { taskId: task.taskId, cursor: queueState.cursor });
      persistQueueState();
      refreshUi(ctx);
      try {
        ctx.ui.notify("Queue reached a human pause. Run /queue resume when ready.", "info");
      } catch {
        // Ignore UI errors
      }
      return;
    }

    if (!restoringActiveTask) {
      const started = markTaskStarted(queueState, "unknown");
      if (!started.ok || !started.state) {
        return;
      }
      queueState = started.state;
    }

    // Build startup content
    let startupContent: string;
    if (queueState.settings.summarizeBetweenTasks) {
      const prevTask = queueState.cursor > 0 ? queueState.tasks[queueState.cursor - 1] : null;
      if (prevTask?.summary) {
        startupContent = `${formatPriorContext(prevTask.taskId, prevTask.summary)}\n\n${task.objective}`;
      } else {
        startupContent = task.objective;
      }
    } else {
      startupContent = task.objective;
    }

    // Create the ThreadGoal and set it
    const result = replaceGoal(startupContent, task.tokenBudget ?? undefined);
    if (!result.ok || !result.goal) {
      return;
    }

    deps.goalController.setGoal(result.goal, "runtime", ctx);

    appendAuditEntry(restoringActiveTask ? "task_restored" : "task_started", {
      taskId: task.taskId,
      objective: task.objective,
      cursor: queueState.cursor,
    });

    persistQueueState();
    queueGoalTurn(ctx);
    refreshUi(ctx);
  };

  /** Detect goal transitions after an agent run. */
  const checkGoalTransition = async (ctx: ExtensionContext): Promise<void> => {
    const goal = deps.goalController.getGoalForDisplay();
    if (!goal) {
      return;
    }

    if (goal.status === "complete") {
      await handleTaskComplete(ctx);
    } else if (goal.status === "paused" || goal.status === "budgetLimited") {
      handleTaskPaused(ctx, goal.status);
    }
  };

  const handleTaskComplete = async (ctx: ExtensionContext): Promise<void> => {
    const taskIndex = queueState.cursor;

    // Capture token usage from the completed goal
    const goal = deps.goalController.getGoalForDisplay();
    const tokensUsed = goal?.usage?.tokensUsed ?? 0;

    // Mark complete with token usage
    const completed = markTaskComplete(queueState, { tokensUsed });
    if (!completed.ok || !completed.state) {
      return;
    }
    queueState = completed.state;
    appendAuditEntry("task_completed", { taskId: queueState.tasks[taskIndex]?.taskId, cursor: taskIndex, tokensUsed });

    // Commit between tasks
    if (queueState.settings.commitBetweenTasks) {
      const task = queueState.tasks[taskIndex];
      if (task?.objective) {
        const commitResult: GitCommitResult = await commitTaskWork(exec, task.objective);
        if (commitResult.committed || commitResult.warning) {
          const rec = recordCommit(queueState, commitResult.sha, commitResult.warning);
          if (rec.ok && rec.state) {
            queueState = rec.state;
          }
        }
      }
    }

    // Summarize between tasks
    if (queueState.settings.summarizeBetweenTasks) {
      const summaryResult = await captureSummary(ctx);
      if (summaryResult.summary) {
        const rec = recordSummary(queueState, summaryResult.summary);
        if (rec.ok && rec.state) {
          queueState = rec.state;
        }
      }
    }

    persistQueueState();

    // Advance to next task
    const { state, advanced } = advanceCursor(queueState);
    queueState = state;

    if (!advanced) {
      appendAuditEntry("queue_complete", {});
      persistQueueState();
      refreshUi(ctx);
      // Auto-show summary on completion via notification
      try {
        ctx.ui.setStatus("pi-queue", "Queue complete.");
      } catch {
        // ignore
      }
      return;
    }

    // Kick off the next task immediately
    persistQueueState();
    startKickoff(ctx);
  };

  const handleTaskPaused = (ctx: ExtensionContext, reason: string): void => {
    const paused = pauseQueue(queueState);
    if (!paused.ok || !paused.state) {
      return;
    }
    queueState = paused.state;

    appendAuditEntry("queue_paused", { reason: `goal became ${reason}` });
    persistQueueState();
    refreshUi(ctx);
  };

  // Register event handlers — these get plain ExtensionContext, not ExtensionCommandContext
  deps.pi.on("session_start", (_event: object, ctx: ExtensionContext) => {
    startKickoff(ctx);
    refreshUi(ctx);
  });

  deps.pi.on("session_tree", (_event: object, ctx: ExtensionContext) => {
    startKickoff(ctx);
  });

  deps.pi.on("agent_end", async (_event: object, ctx: ExtensionContext) => {
    await checkGoalTransition(ctx);
  });

  return {
    getQueueState: () => queueState,
    updateQueueState,
    persistQueueState,
    refreshUi,
    start,
    resume,
    skip,
  };
}
