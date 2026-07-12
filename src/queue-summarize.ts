import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { escapeXmlText } from "./prompts.js";

/** Custom instructions for ctx.compact() asking for a task-to-task summary. */
export const SUMMARY_CUSTOM_INSTRUCTIONS = [
  "Summarize what was accomplished in this task, including:",
  "- Key decisions made",
  "- File paths touched or created",
  "- Remaining known issues or unfinished work",
  "- Anything a fresh agent would need to know to continue",
  "Focus on what the next task needs, not a generic recap.",
].join("\n");

export interface SummarizeResult {
  summary: string | null;
  error: string | null;
}

/**
 * Wraps ctx.compact() to capture a task-transition summary.
 * Returns the summary text via callback.
 */
export function captureSummary(
  ctx: ExtensionContext,
): Promise<SummarizeResult> {
  return new Promise((resolve) => {
    let captured: string | null = null;
    let capturedError: string | null = null;

    try {
      ctx.compact({
        customInstructions: SUMMARY_CUSTOM_INSTRUCTIONS,
        onComplete: (result) => {
          captured = result.summary;
          resolve({ summary: captured, error: capturedError });
        },
        onError: (error) => {
          capturedError = error.message;
          resolve({ summary: null, error: capturedError });
        },
      });
    } catch (error) {
      resolve({
        summary: null,
        error: `compact() unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}

/**
 * Build the prior-context XML fragment to seed the next task's session.
 * Uses the same XML-escaping pattern as prompts.ts for untrusted data.
 */
export function formatPriorContext(
  taskId: string,
  summary: string,
): string {
  const escaped = escapeXmlText(summary);
  return `<pi_queue_prior_context task_id="${taskId}">\n${escaped}\n</pi_queue_prior_context>`;
}
