import assert from "node:assert/strict";
import test from "node:test";

import { commitTaskWork, type ExecFunction } from "../src/queue-git.js";

function fakeExec(results: Array<{ stdout?: string; stderr?: string; code?: number }>): ExecFunction {
  let callIndex = 0;
  return async () => {
    const result = results[callIndex];
    callIndex += 1;
    if (!result) {
      return { stdout: "", stderr: "unexpected call", code: 1, killed: false };
    }
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
      killed: false,
    };
  };
}

test("commitTaskWork does nothing when there are no changes", async () => {
  const exec = fakeExec([{ stdout: "" }]);
  const result = await commitTaskWork(exec, "Add feature X");

  assert.equal(result.committed, false);
  assert.equal(result.sha, null);
  assert.equal(result.warning, null);
});

test("commitTaskWork stages and commits when there are changes", async () => {
  let calls = 0;
  const exec: ExecFunction = async () => {
    calls++;
    if (calls === 1) return { stdout: " M src/main.ts\n", stderr: "", code: 0, killed: false };
    if (calls === 2) return { stdout: "", stderr: "", code: 0, killed: false };
    if (calls === 3) return { stdout: "", stderr: "", code: 0, killed: false };
    if (calls === 4) return { stdout: "abc123def456\n", stderr: "", code: 0, killed: false };
    return { stdout: "", stderr: "unexpected call", code: 1, killed: false };
  };

  const result = await commitTaskWork(exec, "Add feature X");

  assert.equal(result.committed, true);
  assert.equal(result.sha, "abc123def456");
  assert.equal(result.warning, null);
});

test("commitTaskWork records warning when git add fails", async () => {
  const exec = fakeExec([
    { stdout: " M src/main.ts" },
    { stdout: "", stderr: "fatal: not a git repository", code: 128 },
  ]);

  const result = await commitTaskWork(exec, "Add feature X");

  assert.equal(result.committed, false);
  assert.equal(result.sha, null);
  assert.ok(result.warning?.includes("git add -A failed"));
});

test("commitTaskWork records warning when git commit fails", async () => {
  const exec = fakeExec([
    { stdout: " M src/main.ts" },
    { stdout: "", stderr: "", code: 0 },
    { stdout: "", stderr: "nothing to commit", code: 1 },
  ]);

  const result = await commitTaskWork(exec, "Add feature X");

  assert.equal(result.committed, false);
  assert.equal(result.sha, null);
  assert.ok(result.warning?.includes("git commit failed"));
});

test("commitTaskWork handles thrown errors gracefully", async () => {
  const exec: ExecFunction = async () => {
    throw new Error("ENOENT: git not found");
  };

  const result = await commitTaskWork(exec, "Add feature X");

  assert.equal(result.committed, false);
  assert.equal(result.sha, null);
  assert.ok(result.warning?.includes("Git commit failed"));
});

test("commitTaskWork records warning when rev-parse fails after successful commit", async () => {
  const exec = fakeExec([
    { stdout: " M src/main.ts" },
    { stdout: "", stderr: "", code: 0 },
    { stdout: "", stderr: "", code: 0 },
    { stdout: "", stderr: "fatal: not a git repository", code: 128 },
  ]);

  const result = await commitTaskWork(exec, "Add feature X");

  assert.equal(result.committed, true);
  assert.equal(result.sha, null);
  assert.ok(result.warning?.includes("git rev-parse HEAD failed"));
});
