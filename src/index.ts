import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createGoalRuntimeController, registerRuntimeController } from "./goal-runtime-controller.js";
import { registerQueueOrchestrator } from "./queue-orchestrator.js";

export { __testHooks } from "./runtime-config.js";

export default function (pi: ExtensionAPI): void {
  const controller = createGoalRuntimeController(pi);
  registerRuntimeController(pi, controller);
  registerQueueOrchestrator(pi, controller);
}
