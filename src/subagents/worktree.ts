import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Isolation = "none" | "worktree";

export interface WorktreeMetadata {
  isolation: "worktree";
  repoRoot: string;
  worktreePath: string;
  baseCommit: string;
  changedFiles: string[];
  patchPath?: string;
  captureError?: string;
}

export interface TemporaryWorktree {
  repoRoot: string;
  path: string;
  parentDir: string;
  baseCommit: string;
}

function gitRaw(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function git(cwd: string, args: string[]): string {
  return gitRaw(cwd, args).trim();
}

/** Parse porcelain v1 -z output, including the destination and source of renames. */
export function parseChangedFiles(porcelain: string): string[] {
  const records = porcelain.split("\0");
  const files: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const status = record.slice(0, 2);
    const file = record.slice(3);
    if (file) files.push(file);
    if (status.includes("R") || status.includes("C")) {
      const source = records[++i];
      if (source) files.push(source);
    }
  }
  return [...new Set(files)].sort();
}

export function createTemporaryWorktree(sourceCwd: string): TemporaryWorktree {
  let repoRoot: string;
  try {
    repoRoot = git(sourceCwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    throw new Error(`Worktree isolation requires a git repository: ${sourceCwd}`);
  }
  if (git(repoRoot, ["status", "--porcelain", "--untracked-files=all"])) {
    throw new Error(`Worktree isolation requires a clean source tree: ${repoRoot}`);
  }

  const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]);
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-worktree-"));
  const worktreePath = path.join(parentDir, "checkout");
  try {
    execFileSync("git", ["-C", repoRoot, "worktree", "add", "--detach", worktreePath, baseCommit], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    fs.rmSync(parentDir, { recursive: true, force: true });
    throw new Error(`Could not create temporary git worktree: ${(error as Error).message}`);
  }
  return { repoRoot, path: worktreePath, parentDir, baseCommit };
}

export function remapWorktreeCwd(sourceCwd: string, worktree: TemporaryWorktree): string {
  const relative = path.relative(worktree.repoRoot, path.resolve(sourceCwd));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Working directory is outside the isolated repository: ${sourceCwd}`);
  }
  return path.join(worktree.path, relative);
}

/** Capture a --binary patch outside the checkout, then remove the detached worktree. */
export function finishTemporaryWorktree(worktree: TemporaryWorktree): WorktreeMetadata {
  let changedFiles: string[] = [];
  let patchPath: string | undefined;
  let captureError: string | undefined;
  try {
    const porcelain = gitRaw(worktree.path, ["status", "--porcelain", "-z", "--untracked-files=all"]);
    const statusFiles = parseChangedFiles(porcelain);
    const committedFiles = gitRaw(worktree.path, ["diff", "--name-only", "-z", worktree.baseCommit])
      .split("\0")
      .filter(Boolean);
    changedFiles = [...new Set([...statusFiles, ...committedFiles])].sort();
    if (statusFiles.length > 0) {
      // Intent-to-add makes untracked files visible to diff without changing the source repository's index.
      execFileSync("git", ["-C", worktree.path, "add", "-N", "--", "."], { stdio: "ignore" });
    }
    const patch = execFileSync("git", ["-C", worktree.path, "diff", "--binary", "--no-ext-diff", worktree.baseCommit], {
      encoding: "buffer",
      maxBuffer: 100 * 1024 * 1024,
    });
    const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-essentials-subagent-patch-"));
    patchPath = path.join(artifactDir, "changes.patch");
    fs.writeFileSync(patchPath, patch, { mode: 0o600 });
  } catch (error) {
    // The child already completed; artifact failures must not erase its answer.
    captureError = `Could not capture isolated changes: ${(error as Error).message}`;
  } finally {
    try {
      execFileSync("git", ["-C", worktree.repoRoot, "worktree", "remove", "--force", worktree.path], { stdio: "ignore" });
    } catch (error) {
      captureError ??= `Could not remove temporary worktree: ${(error as Error).message}`;
    }
    try {
      fs.rmSync(worktree.parentDir, { recursive: true, force: true });
    } catch (error) {
      captureError ??= `Could not remove temporary worktree directory: ${(error as Error).message}`;
    }
  }
  return {
    isolation: "worktree",
    repoRoot: worktree.repoRoot,
    worktreePath: worktree.path,
    baseCommit: worktree.baseCommit,
    changedFiles,
    patchPath,
    captureError,
  };
}
