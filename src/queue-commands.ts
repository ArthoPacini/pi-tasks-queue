import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import { formatQueueStatusBox, formatTaskPreview } from "./queue-format.js";
import type { QueueRuntimeController } from "./queue-runtime-controller.js";
import {
  addTask,
  appendTask,
  clearQueue,
  createPauseTask,
  editTask,
  removeTask,
  replaceWithPause,
  setCommitSetting,
  setRunState,
  setStatusWidgetSetting,
  setSummarizeSetting,
  startQueue,
} from "./queue-state.js";

type QueueCommandHost = Pick<
  QueueRuntimeController,
  "getQueueState" | "updateQueueState" | "persistQueueState" | "refreshUi" | "start" | "resume" | "skip"
>;

export interface QueueCommandContext {
  hasUI: boolean;
  ui: Pick<ExtensionCommandContext["ui"], "confirm" | "editor" | "notify" | "setStatus" | "setWidget">;
}

const SUBCOMMANDS = [
  "add",
  "list",
  "status",
  "edit",
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

  // Subcommand is fully typed; offer argument completions for toggles.
  if ((subcommand === "commit" || subcommand === "summarize" || subcommand === "status") && parts.length === 2) {
    const arg = parts[1] ?? "";
    const values = subcommand === "status" ? ["toggle", "on", "off"] : ["on", "off"];
    return values
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
  return args.trim().replace(/^\S+\s*/, "").trim();
}

function parseIndex(arg: string): number | null {
  if (!/^\d+$/.test(arg)) {
    return null;
  }
  const n = Number(arg);
  if (!Number.isSafeInteger(n) || n < 1) {
    return null;
  }
  return n - 1;
}

export async function handleQueueCommand(
  host: QueueCommandHost,
  args: string,
  ctx: QueueCommandContext | ExtensionCommandContext,
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
      const result = rest.toLowerCase() === "pause"
        ? { ok: true, message: "Human pause added.", task: createPauseTask() }
        : addTask(current, rest);
      if (!result.ok || !result.task) {
        ctx.ui.notify(result.message, "error");
        return;
      }
      const task = result.task;
      host.updateQueueState((state) => appendTask(state, task));
      host.persistQueueState();
      host.refreshUi(ctx);
      ctx.ui.notify(task.kind === "pause" ? "Human pause added." : `Task added: ${formatTaskPreview(rest)}`);
      break;
    }

    case "list":
    case "status": {
      if (cmd === "status" && rest) {
        const current = host.getQueueState();
        const normalized = rest.toLowerCase();
        const value = normalized === "toggle"
          ? !current.settings.showStatusWidget
          : normalized === "on"
            ? true
            : normalized === "off"
              ? false
              : null;
        if (value === null) {
          ctx.ui.notify("Usage: /queue status [toggle|on|off]", "warning");
          return;
        }
        host.updateQueueState((state) => setStatusWidgetSetting(state, value));
        host.persistQueueState();
        host.refreshUi(ctx);
        ctx.ui.notify(`Live queue status ${value ? "enabled" : "disabled"}.`);
        return;
      }
      const box = formatQueueStatusBox(host.getQueueState());
      ctx.ui.notify(box);
      break;
    }

    case "edit": {
      const indexArg = rest.split(/\s+/, 1)[0] ?? "";
      const index = parseIndex(indexArg);
      if (index === null) {
        ctx.ui.notify("Usage: /queue edit <index> [new objective]", "warning");
        return;
      }
      const currentTask = host.getQueueState().tasks[index];
      if (!currentTask) {
        ctx.ui.notify("Task index out of range.", "warning");
        return;
      }
      if (currentTask.status !== "pending") {
        ctx.ui.notify("Only pending tasks can be edited.", "warning");
        return;
      }

      const inlineObjective = rest.replace(/^\S+\s*/, "").trim();
      let objective = inlineObjective;
      if (!objective) {
        if (!ctx.hasUI) {
          ctx.ui.notify("Usage: /queue edit <index> <new objective>", "warning");
          return;
        }
        const edited = await ctx.ui.editor(
          `Edit queue entry ${index + 1}`,
          currentTask.kind === "pause" ? "pause" : currentTask.objective,
        );
        if (edited === undefined) {
          ctx.ui.notify("Queue unchanged.");
          return;
        }
        objective = edited.trim();
      }

      const result = objective.toLowerCase() === "pause"
        ? replaceWithPause(host.getQueueState(), index)
        : editTask(host.getQueueState(), index, objective);
      if (!result.ok || !result.state) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      const nextState = result.state;
      host.updateQueueState(() => nextState);
      host.persistQueueState();
      host.refreshUi(ctx);
      ctx.ui.notify(result.task?.kind === "pause" ? "Entry replaced with a human pause." : "Task edited.");
      break;
    }

    case "start": {
      const result = startQueue(host.getQueueState());
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      // Notify before session replacement; the command ctx becomes stale once
      // the fresh task session has been installed.
      ctx.ui.notify("Queue started.");
      await host.start(ctx as Parameters<typeof host.start>[0]);
      return;
    }

    case "pause": {
      const state = host.getQueueState();
      if (state.runState !== "running") {
        ctx.ui.notify("Queue is not running.", "warning");
        return;
      }
      host.updateQueueState((state) => setRunState(state, "paused"));
      host.persistQueueState();
      host.refreshUi(ctx);
      ctx.ui.notify("Queue paused.");
      break;
    }

    case "resume": {
      const result = await host.resume(ctx as Parameters<typeof host.resume>[0]);
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
      host.persistQueueState();
      ctx.ui.notify("Queue resumed.");
      break;
    }

    case "skip": {
      const result = await host.skip(ctx as Parameters<typeof host.skip>[0]);
      if (!result.ok) {
        ctx.ui.notify(result.message, "warning");
        return;
      }
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
      host.refreshUi(ctx);
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
      host.refreshUi(ctx);
      ctx.ui.notify("Queue cleared.");
      break;
    }

    case "commit": {
      const normalized = rest.toLowerCase();
      const value = normalized === "on" ? true : normalized === "off" ? false : null;
      if (value === null) {
        ctx.ui.notify("Usage: /queue commit on|off", "warning");
        return;
      }
      host.updateQueueState((state) => setCommitSetting(state, value));
      host.persistQueueState();
      host.refreshUi(ctx);
      ctx.ui.notify(`Auto-commit ${value ? "enabled" : "disabled"}.`);
      break;
    }

    case "summarize": {
      const normalized = rest.toLowerCase();
      const value = normalized === "on" ? true : normalized === "off" ? false : null;
      if (value === null) {
        ctx.ui.notify("Usage: /queue summarize on|off", "warning");
        return;
      }
      host.updateQueueState((state) => setSummarizeSetting(state, value));
      host.persistQueueState();
      host.refreshUi(ctx);
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
      await handleQueueCommand(host, args, ctx as Parameters<typeof handleQueueCommand>[2]);
    },
  });
}
