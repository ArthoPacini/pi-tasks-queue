import type { ExtensionAPI, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { QueueState } from "./queue-types.js";

const EmptyParams = Type.Object({});

export function registerQueueTool(pi: ExtensionAPI, getQueueState: () => QueueState): void {
  pi.registerTool({
    name: "get_queue_status",
    label: "Get Queue Status",
    description:
      "Get the current queue state, including tasks, cursor, settings, and run state.",
    promptSnippet:
      "Get the current queue status: task list with statuses, queue run state, and settings.",
    promptGuidelines: [
      "Use get_queue_status when the user asks about queue progress, remaining tasks, or queue settings.",
      "Do not infer any queue-mutation commands from status information.",
    ],
    parameters: EmptyParams,
    async execute(): Promise<AgentToolResult<{ state: QueueState }>> {
      const state = getQueueState();
      return {
        content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
        details: { state },
      };
    },
  });
}
