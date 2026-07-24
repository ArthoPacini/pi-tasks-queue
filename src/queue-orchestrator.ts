import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createQueueRuntimeController, type QueueRuntimeController } from "./queue-runtime-controller.js";
import { registerQueueCommand } from "./queue-commands.js";
import { registerQueueTools } from "./queue-tools.js";
import type { GoalRuntimeController } from "./goal-runtime-controller.js";

export function registerQueueOrchestrator(pi: ExtensionAPI, goalController: GoalRuntimeController): void {
  const flag = pi.getFlag?.("project-root");
  const projectRoot = typeof flag === "string" ? flag : process.cwd();
  const controller = createQueueRuntimeController({
    pi,
    goalController,
    projectRoot,
  });

  // Register model-callable queue inspection and mutation tools.
  registerQueueTools(pi, controller);

  // Register /queue commands
  registerQueueCommand(pi, {
    getQueueState: controller.getQueueState,
    updateQueueState: controller.updateQueueState,
    persistQueueState: controller.persistQueueState,
    refreshUi: controller.refreshUi,
    start: controller.start,
    resume: controller.resume,
    skip: controller.skip,
  });
}

/** Used by tests — creates the controller without registering commands/tools. */
export function createQueueRuntimeControllerForTesting(
  pi: ExtensionAPI,
  goalController: GoalRuntimeController,
  projectRoot: string,
): QueueRuntimeController {
  return createQueueRuntimeController({ pi, goalController, projectRoot });
}
