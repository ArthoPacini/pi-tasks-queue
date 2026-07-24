import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createQueuePersistence } from "../src/queue-persistence.js";
import {
  addTask,
  appendTask,
  createQueueState,
  createQueueTask,
  setCommitSetting,
} from "../src/queue-state.js";

function tempProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "queue-persist-test-"));
  // Create .pi directory so lookup succeeds but file doesn't exist yet
  mkdirSync(join(dir, ".pi"), { recursive: true });
  return dir;
}

test("load creates empty queue when file does not exist", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  const state = persistence.load();

  assert.equal(state.version, 1);
  assert.deepEqual(state.tasks, []);
  assert.equal(state.runState, "idle");

  // Verify file was written
  assert.ok(existsSync(persistence.queuePath));
});

test("load returns saved state on second call", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  const loaded = persistence.load();
  const t1 = createQueueTask("task1", null, 100);
  const modified = appendTask(loaded, t1, 101);

  persistence.save(modified);

  // Create a new persistence instance (simulates reload)
  const p2 = createQueuePersistence({ projectRoot: dir });
  const reloaded = p2.load();
  assert.equal(reloaded.tasks.length, 1);
  assert.equal(reloaded.tasks[0]?.objective, "task1");
  assert.equal(reloaded.updatedAt, 101);
});

test("atomic write followed by read returns the correct data", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  let state = persistence.load();
  state = appendTask(state, createQueueTask("first", null, 100), 101);
  state = setCommitSetting(state, true, 102);
  persistence.save(state);

  const p2 = createQueuePersistence({ projectRoot: dir });
  const loaded = p2.load();
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0]?.objective, "first");
  assert.equal(loaded.settings.commitBetweenTasks, true);
  assert.equal(loaded.updatedAt, 102);
});

test("revision conflict causes save to return false", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  const state = persistence.load(); // updatedAt = some value

  // Modify on disk behind persistence's back
  const t1 = createQueueTask("sneaky", null, 100);
  const modified = appendTask(state, t1, 200);
  writeFileSync(persistence.queuePath, JSON.stringify(modified));

  // Now try to save the original loaded state — should detect conflict
  const result = persistence.save(state);
  assert.equal(result, false);
});

test("update performs atomic read-modify-write", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  const result = persistence.update((state) => {
    const task = createQueueTask("added via update", null, 100);
    return appendTask(state, task, 101);
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0]?.objective, "added via update");

  // Verify on disk
  const raw = JSON.parse(readFileSync(persistence.queuePath, "utf8"));
  assert.equal(raw.tasks.length, 1);
});

test("multiple updates compose correctly", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  const first = persistence.update((state) => {
    return appendTask(state, createQueueTask("first", null, 100), 101);
  });
  assert.equal(first.tasks.length, 1);

  const second = persistence.update((state) => {
    return appendTask(state, createQueueTask("second", null, 100), 102);
  });
  assert.equal(second.tasks.length, 2);
  assert.equal(second.tasks[0]?.objective, "first");
  assert.equal(second.tasks[1]?.objective, "second");
});

test("load after reset bootstraps empty state", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  persistence.load(); // Creates file
  persistence.reset();

  const p2 = createQueuePersistence({ projectRoot: dir });
  const loaded = p2.load();
  assert.deepEqual(loaded.tasks, []);
  assert.equal(loaded.runState, "idle");
});

test("load supplies defaults for queue files written before kinds and live status", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });
  const state = appendTask(createQueueState(0), createQueueTask("legacy task", null, 0), 1);
  const task = state.tasks[0];
  assert.ok(task);
  const { kind: _kind, ...legacyTask } = task;
  const { showStatusWidget: _showStatusWidget, ...legacySettings } = state.settings;
  const legacyState = { ...state, tasks: [legacyTask], settings: legacySettings };
  mkdirSync(join(dir, ".pi", "pi-queue"), { recursive: true });
  writeFileSync(persistence.queuePath, JSON.stringify(legacyState));

  const loaded = persistence.load();
  assert.equal(loaded.tasks[0]?.kind, "task");
  assert.equal(loaded.settings.showStatusWidget, false);
});

test("corrupt file throws on parse", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  // Write invalid JSON
  mkdirSync(join(dir, ".pi", "pi-queue"), { recursive: true });
  writeFileSync(persistence.queuePath, "not-json");

  assert.throws(() => persistence.load(), SyntaxError);
});

test("unsupported version throws descriptive error", () => {
  const dir = tempProjectDir();
  const persistence = createQueuePersistence({ projectRoot: dir });

  mkdirSync(join(dir, ".pi", "pi-queue"), { recursive: true });
  writeFileSync(persistence.queuePath, JSON.stringify({ version: 99 }));

  assert.throws(
    () => persistence.load(),
    /Unsupported queue state version: 99/,
  );
});
