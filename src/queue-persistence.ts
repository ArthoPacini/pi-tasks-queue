import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { createQueueState } from "./queue-state.js";
import type { QueueState } from "./queue-types.js";

export const QUEUE_STATE_FILENAME = "queue.json";

export interface QueuePersistenceDeps {
  projectRoot: string;
}

export function normalizeQueueState(state: QueueState): QueueState {
  return {
    ...state,
    tasks: state.tasks.map((task) => ({
      ...task,
      kind: task.kind ?? "task",
    })),
    settings: {
      commitBetweenTasks: state.settings.commitBetweenTasks ?? false,
      summarizeBetweenTasks: state.settings.summarizeBetweenTasks ?? false,
      showStatusWidget: state.settings.showStatusWidget ?? false,
    },
  };
}

function isDescendant(ancestor: string, candidate: string): boolean {
  const relativePath = relative(ancestor, candidate);
  return !relativePath.startsWith("..") && !sep.startsWith(relativePath);
}

export function createQueuePersistence(deps: QueuePersistenceDeps) {
  const queueDir = join(deps.projectRoot, ".pi", "pi-queue");
  const queuePath = join(queueDir, QUEUE_STATE_FILENAME);

  let lastKnownRevision: number | null = null;

  const ensureDir = (): void => {
    mkdirSync(queueDir, { recursive: true });
  };

  const readOnDiskRevision = (): number | null => {
    try {
      const raw = readFileSync(queuePath, "utf8");
      return (JSON.parse(raw) as QueueState).revision;
    } catch {
      return null;
    }
  };

  const load = (): QueueState => {
    let data: string;
    try {
      data = readFileSync(queuePath, "utf8");
    } catch {
      // File doesn't exist => bootstrap empty state
      ensureDir();
      const empty = createQueueState();
      writeAtomic(empty);
      lastKnownRevision = empty.revision;
      return empty;
    }

    const parsed = JSON.parse(data) as QueueState;
    if (parsed.version !== 1) {
      throw new Error(`Unsupported queue state version: ${parsed.version}`);
    }
    const normalized = normalizeQueueState(parsed);
    lastKnownRevision = normalized.revision;
    return normalized;
  };

  const save = (state: QueueState): boolean => {
    ensureDir();

    const diskRevision = readOnDiskRevision();
    if (diskRevision !== null && lastKnownRevision !== null && diskRevision !== lastKnownRevision) {
      return false; // Conflict: on-disk state is newer than what we loaded
    }

    writeAtomic(state);
    lastKnownRevision = state.revision;
    return true;
  };

  /** Read-modify-write with reload-then-retry on conflict. */
  const update = (modify: (state: QueueState) => QueueState): QueueState => {
    const before = load();

    for (let attempt = 0; attempt < 10; attempt++) {
      const next = modify(before);
      const diskRevision = readOnDiskRevision();
      if (diskRevision !== null && lastKnownRevision !== null && diskRevision !== lastKnownRevision) {
        // Reload and retry
        const reloaded = load();
        const retry = modify(reloaded);
        writeAtomic(retry);
        lastKnownRevision = retry.revision;
        return retry;
      }
      writeAtomic(next);
      lastKnownRevision = next.revision;
      return next;
    }

    // Fallback: just write
    const result = modify(before);
    writeAtomic(result);
    lastKnownRevision = result.revision;
    return result;
  };

  const writeAtomic = (state: QueueState): void => {
    ensureDir();
    const tmpPath = join(queueDir, `.queue.tmp.${process.pid}`);

    if (!isDescendant(deps.projectRoot, tmpPath)) {
      throw new Error(`Temporary path ${tmpPath} is outside project root.`);
    }

    writeFileSync(tmpPath, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmpPath, queuePath);
  };

  const reset = (): void => {
    try {
      rmSync(queueDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup failures
    }
    lastKnownRevision = null;
  };

  return {
    load,
    save,
    update,
    queuePath,
    reset,
  };
}

export type QueuePersistence = ReturnType<typeof createQueuePersistence>;
