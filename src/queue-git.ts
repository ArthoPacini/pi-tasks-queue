export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export interface GitCommitResult {
  sha: string | null;
  warning: string | null;
  committed: boolean;
}

export type ExecFunction = (command: string, args?: string[]) => Promise<GitExecResult>;

function commitMessage(objective: string): string {
  const maxLen = 72;
  const prefix = "pi-queue: ";
  const truncated = objective.length > maxLen - prefix.length
    ? `${objective.slice(0, maxLen - prefix.length - 3)}...`
    : objective;
  return `${prefix}${truncated}`;
}

/** Run git status --porcelain. Returns true if there's something to commit. */
async function hasChanges(exec: ExecFunction): Promise<boolean> {
  const result = await exec("git", ["status", "--porcelain"]);
  if (result.code !== 0) {
    throw new Error(
      `git status --porcelain failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
    );
  }
  return result.stdout.trim().length > 0;
}

/** Run git add -A to stage all changes. */
async function stageAll(exec: ExecFunction): Promise<GitCommitResult> {
  const result = await exec("git", ["add", "-A"]);
  if (result.code !== 0) {
    return {
      sha: null,
      warning: `git add -A failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
      committed: false,
    };
  }
  return { sha: null, warning: null, committed: false };
}

/** Run git commit with a message derived from the task objective. */
async function commit(exec: ExecFunction, objective: string): Promise<GitCommitResult> {
  const message = commitMessage(objective);
  const result = await exec("git", ["commit", "-m", message]);
  if (result.code !== 0) {
    return {
      sha: null,
      warning: `git commit failed: ${result.stderr.trim() || `exit code ${result.code}`}`,
      committed: false,
    };
  }

  const shaResult = await exec("git", ["rev-parse", "HEAD"]);
  if (shaResult.code !== 0) {
    return {
      sha: null,
      warning: `git rev-parse HEAD failed: ${shaResult.stderr.trim() || `exit code ${shaResult.code}`}`,
      committed: true,
    };
  }

  return {
    sha: shaResult.stdout.trim(),
    warning: null,
    committed: true,
  };
}

/**
 * Run the full commit flow: status check, stage, commit.
 * Never throws — returns a result describing what happened.
 */
export async function commitTaskWork(
  exec: ExecFunction,
  objective: string,
): Promise<GitCommitResult> {
  try {
    const changed = await hasChanges(exec);
    if (!changed) {
      return { sha: null, warning: null, committed: false };
    }

    const stageResult = await stageAll(exec);
    if (stageResult.warning) {
      return stageResult;
    }

    return await commit(exec, objective);
  } catch (error) {
    return {
      sha: null,
      warning: `Git commit failed: ${error instanceof Error ? error.message : String(error)}`,
      committed: false,
    };
  }
}
