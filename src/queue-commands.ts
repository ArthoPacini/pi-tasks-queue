import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatQueueStatusBox } from "./queue-format.js";
import type { QueueRuntimeController } from "./queue-runtime-controller.js";
import {
  addTask,
  appendTask,
  clearQueue,
  removeTask,
  resumeQueue,
  setCommitSetting,
  setRunState,
  setSummarizeSetting,
  skipCurrentTask,
  startQueue,
} from "./queue-state.js";

type QueueCommandHost = Pick<QueueRuntimeController, "getQueueState" | "updateQueueState" | "persistQueueState">;

export interface QueueCommandContext {
  hasUI: boolean;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "notify" | "setStatus">;
}

const SUBCOMMANDS = [
  "add",
  "list",
  "status",
  "start",
  "pause",
  "resume",
  "skip",
  "remove",
  "clear",
  "commit",
  "summarize",
] as const;

function completions(prefix: string) {
  const trimmed = prefix.trim();
  if (!trimmed) {
    return SUBCOMMANDS.map((cmd) => ({
      value: cmd,
      label: cmd,
      description: `queue ${cmd}`,
    }));
  }

  const parts = trimmed.split(/\s+/);
  const subcommand = parts[0]?.toLowerCase() ?? "";

  // Still typing the subcommand itself (no space yet) — offer subcommand completions
  if (parts.length === 1) {
    return SUBCOMMANDS.filter((cmd) => cmd.startsWith(subcommand)).map((cmd) => ({
      value: cmd,
      label: cmd,
      description: `queue ${cmd}`,
    }));
  }

  // Subcommand is fully typed; offer argument completions for commit/summarize
  if ((subcommand === "commit" || subcommand === "summarize") && parts.length === 2) {
    const arg = parts[1] ?? "";
    return ["on", "off"]
      .filter((a) => a.startsWith(arg))
      .map((a) => ({
        value: a,
        label: a,
        description: `queue ${subcommand} ${a}`,
      }));
  }

  // Subcommand + arguments already typed; stay out of the way
  return [];
}

function firstArg(args: string): string {
  return args.trim().split(/\s+/)[0]?.trim().toLowerCase() ?? "";
}

function restOfArgs(args: string): string {
  const parts = args.trim().split(/\s+/);
  return parts.slice(1).join(" ").trim();
}

function parseIndex(arg: string): number | null {
  const n = parseInt(arg, 10);
  if (Number.isNaN(n) || n < 1) {
    return null;
  }
  return n - 1;
}

export async function handleQueueCommand(
  host: QueueCommandHost,
  args: string,
  ctx: QueueCommandContext,
): Promise<void> {
  const cmd = firstArg(args);
  const rest = restOfArgs(args);

  switch (cmd) {
    case "add": {
      if (!rest) {
        ctx.ui.notify("Usage: /queue add <objective>", "warning");
        return;
      }
      const current = host.getQueueState();
      const result = addTask(current, rest);
      if (!result.ok || !result.task) {
        ctx.ui.notify(result.message, "error");
        return;
      }
      const task = result.task;
      host.updateQueueState((state) => appendTask(state, task));
      host.persistQueueState();
      ctx.ui.notify(`Task added: ${rest}`);
      break;
    }

    case "list":
    case "status": {
      const box = formatQueueStatusBox(host.getQueueState());
      ctx.ui.notify(box);
      break;
    }

    case "start": {
      const result = startQueue(host.getQueueState());
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      host.updateQueueState((state) => setRunState(state, "running"));
      host.persistQueueState();
      ctx.ui.notify("Queue started.");
      break;
    }

    case "pause": {
      const state = host.getQueueState();
      if (state.runState !== "running") {
        ctx.ui.notify("Queue is not running.", "warning");
        return;
      }
      host.updateQueueState((state) => setRunState(state, "paused"));
      host.persistQueueState();
      ctx.ui.notify("Queue paused.");
      break;
    }

    case "resume": {
      const result = resumeQueue(host.getQueueState());
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      host.updateQueueState((state) => ({ ...state, runState: "running" as const }));
      host.persistQueueState();
      ctx.ui.notify("Queue resumed.");
      break;
    }

    case "skip": {
      const result = skipCurrentTask(host.getQueueState());
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      host.updateQueueState((state) => result.state ?? state);
      host.persistQueueState();
      ctx.ui.notify("Current task skipped.");
      break;
    }

    case "remove": {
      if (!rest) {
        ctx.ui.notify("Usage: /queue remove <index>", "warning");
        return;
      }
      const index = parseIndex(rest);
      if (index === null) {
        ctx.ui.notify("Invalid index. Use the 1-based number shown in /queue list.", "warning");
        return;
      }
      const result = removeTask(host.getQueueState(), index);
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      if (result.state) {
        host.updateQueueState(() => result.state!);
      }
      host.persistQueueState();
      ctx.ui.notify("Task removed.");
      break;
    }

    case "clear": {
      const taskCount = host.getQueueState().tasks.length;
      if (taskCount === 0) {
        ctx.ui.notify("Queue is already empty.", "warning");
        return;
      }
      const confirmed = await ctx.ui.confirm(
        "Clear all tasks?",
        `This removes all ${taskCount} task(s) from the queue.`,
      );
      if (!confirmed) {
        ctx.ui.notify("Queue unchanged.");
        return;
      }
      host.updateQueueState((state) => clearQueue(state));
      host.persistQueueState();
      ctx.ui.notify("Queue cleared.");
      break;
    }

    case "commit": {
      const value = rest === "on" ? true : rest === "off" ? false : null;
      if (value === null) {
        ctx.ui.notify("Usage: /queue commit on|off", "warning");
        return;
      }
      host.updateQueueState((state) => setCommitSetting(state, value));
      host.persistQueueState();
      ctx.ui.notify(`Auto-commit ${value ? "enabled" : "disabled"}.`);
      break;
    }

    case "summarize": {
      const value = rest === "on" ? true : rest === "off" ? false : null;
      if (value === null) {
        ctx.ui.notify("Usage: /queue summarize on|off", "warning");
        return;
      }
      host.updateQueueState((state) => setSummarizeSetting(state, value));
      host.persistQueueState();
      ctx.ui.notify(`Auto-summarize ${value ? "enabled" : "disabled"}.`);
      break;
    }

    default: {
      ctx.ui.notify(
        `Unknown subcommand: ${cmd}. Available: ${SUBCOMMANDS.join(", ")}`,
        "warning",
      );
    }
  }
}

export function registerQueueCommand(pi: ExtensionAPI, host: QueueCommandHost): void {
  pi.registerCommand("queue", {
    description: "Manage the multi-task queue.",
    getArgumentCompletions(argumentPrefix) {
      return completions(argumentPrefix.trim());
    },
    async handler(args: string, ctx: ExtensionCommandContext) {
      await handleQueueCommand(host, args, ctx);
    },
  });
}
