import { StringEnum } from "@earendil-works/pi-ai/compat";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { formatQueueStateJson } from "./queue-format.js";
import type { QueueRuntimeController } from "./queue-runtime-controller.js";
import { addTask, appendTask, createPauseTask, editTask } from "./queue-state.js";
import type { QueueState, QueueTask } from "./queue-types.js";

const EmptyParams = Type.Object({});

const AddQueueTasksParams = Type.Object({
  tasks: Type.Array(
    Type.Object({
      kind: StringEnum(["task", "pause"] as const, {
        description: "Use task for agent work or pause for a human checkpoint.",
      }),
      objective: Type.Optional(Type.String({
        description: "Required when kind is task. Omit for a pause.",
      })),
      token_budget: Type.Optional(Type.Integer({
        description: "Optional positive token budget for a task.",
        minimum: 1,
      })),
    }),
    {
      description: "Queue entries to append in this exact order.",
      minItems: 1,
    },
  ),
});

const EditQueueTaskParams = Type.Object({
  index: Type.Integer({
    description: "1-based task number shown by get_queue_status.",
    minimum: 1,
  }),
  objective: Type.String({ description: "Replacement objective for the pending task." }),
  token_budget: Type.Optional(Type.Integer({
    description: "Optional replacement token budget. Omit to preserve the current budget.",
    minimum: 1,
  })),
});

type QueueToolHost = Pick<
  QueueRuntimeController,
  "getQueueState" | "updateQueueState" | "persistQueueState" | "refreshUi"
>;

function stateResult(state: QueueState, message?: string): AgentToolResult<{ state: QueueState }> {
  return {
    content: [{
      type: "text",
      text: message ? `${message}\n${formatQueueStateJson(state)}` : formatQueueStateJson(state),
    }],
    details: { state },
  };
}

function throwToolError(message: string): never {
  throw new Error(message);
}

function persistMutation(host: QueueToolHost, state: QueueState, ctx: ExtensionContext): QueueState {
  host.updateQueueState(() => state);
  host.persistQueueState();
  host.refreshUi(ctx);
  return host.getQueueState();
}

export function registerQueueTools(pi: ExtensionAPI, host: QueueToolHost): void {
  pi.registerTool({
    name: "get_queue_status",
    label: "Get Queue Status",
    description:
      "Get the current queue state, including tasks, human pause checkpoints, cursor, settings, and run state.",
    promptSnippet:
      "Get the current queue status: task list with statuses, queue run state, and settings.",
    promptGuidelines: [
      "Use get_queue_status when the user asks about queue progress, remaining tasks, or queue settings.",
    ],
    parameters: EmptyParams,
    async execute(): Promise<AgentToolResult<{ state: QueueState }>> {
      return stateResult(host.getQueueState());
    },
  });

  pi.registerTool({
    name: "add_queue_tasks",
    label: "Add Queue Tasks",
    description:
      "Append one or more agent tasks or human pause checkpoints to the queue in the exact supplied order. Use this after reading a task, plan, or checklist file when the user asks to import its work. This does not start the queue.",
    promptSnippet:
      "Append ordered tasks and human pause checkpoints to the queue, including tasks extracted from files, without starting it.",
    promptGuidelines: [
      "Use add_queue_tasks when the user explicitly asks you to add, enqueue, defer, or import work into the queue, including natural-language requests that do not use /queue.",
      "When the user asks to read a task, plan, or checklist file and create queue tasks from it, use read to inspect the file, interpret its actionable entries, then call add_queue_tasks with those entries in source order.",
      "Use a pause entry in add_queue_tasks when the source file or user requests a human checkpoint between queued tasks.",
      "Do not start the queue after add_queue_tasks unless the user also explicitly asks you to start it.",
      "Do not claim work was queued until add_queue_tasks succeeds.",
    ],
    parameters: AddQueueTasksParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const current = host.getQueueState();
      const additions: QueueTask[] = [];
      for (const entry of params.tasks) {
        if (entry.kind === "pause") {
          additions.push(createPauseTask());
          continue;
        }
        if (entry.objective === undefined) {
          throwToolError("Each task entry requires an objective.");
        }
        const result = addTask(current, entry.objective, entry.token_budget ?? null);
        if (!result.ok || !result.task) {
          throwToolError(result.message);
        }
        additions.push(result.task);
      }

      let next = current;
      for (const task of additions) {
        next = appendTask(next, task);
      }
      const state = persistMutation(host, next, ctx);
      return stateResult(state, `Added ${additions.length} queue entr${additions.length === 1 ? "y" : "ies"}.`);
    },
  });

  pi.registerTool({
    name: "edit_queue_task",
    label: "Edit Queue Task",
    description:
      "Replace the objective of a pending queue task by its 1-based number. Active or previously executed tasks cannot be edited.",
    promptSnippet: "Edit a pending queue task by its 1-based number.",
    promptGuidelines: [
      "Use edit_queue_task only for pending queue tasks; never edit active or previously executed tasks.",
    ],
    parameters: EditQueueTaskParams,
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = editTask(
        host.getQueueState(),
        params.index - 1,
        params.objective,
        params.token_budget,
      );
      if (!result.ok || !result.state) {
        throwToolError(result.message);
      }
      const state = persistMutation(host, result.state, ctx);
      return stateResult(state, `Edited queue task ${params.index}.`);
    },
  });
}
