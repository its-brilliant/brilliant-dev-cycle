/**
 * The real git effects (spec §7.3): a branch per run, phase and task, one worktree per branch
 * under `.worktrees/`, merges that fast-forward when they can, and the commits a fix is routed by
 * (§4.4).
 *
 * Every call is `git -C <dir> …` through `child_process` with no shell and
 * `GIT_TERMINAL_PROMPT=0`, so a missing credential fails instead of waiting for a prompt. The root
 * checkout never moves: bdc only adds branches, worktrees and merges, and it never discards work
 * somebody left in a worktree.
 *
 * Every step is idempotent, because XState restarts invocations on restore (§5.7): an existing
 * branch or worktree is reused, and merging a branch that is already in answers the current head.
 *
 * The command runner is a parameter, so tests can watch the exact calls; the git tests run the
 * real git against throwaway repositories.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fromPromise } from 'xstate';
import type { PromiseActorLogic } from 'xstate';
import type {
  CommitsSinceInput,
  CommitsSinceOutput,
  EnsureWorktreeInput,
  EnsureWorktreeOutput,
  MergeBranchInput,
  MergeBranchOutput,
} from '../contracts/actors.js';

// ── running a command ──────────────────────────────────────────────────────────────────────

/** What one command printed and how it ended. `error` is set when the binary could not run at all. */
export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

export interface CommandOptions {
  cwd?: string;
  /** Extra environment on top of this process's, never instead of it. */
  env?: Record<string, string>;
}

/** One process, by name and argv. No shell, so nothing here depends on quoting. */
export type RunCommand = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>;

export const runProcess: RunCommand = (command, args, options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (error) => resolve({ code: null, stdout, stderr, error }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });

/** Last line or two of output: enough for a person to see what the command said. */
export function outputTail(text: string): string {
  const lines = text.trim().split('\n').filter((line) => line.trim() !== '');
  return lines.length === 0 ? '(no output)' : lines.slice(-3).join(' | ');
}

// ── git itself ─────────────────────────────────────────────────────────────────────────────

/** What every git call needs: which binary, and how to run it. */
export interface GitContext {
  gitBin: string;
  run: RunCommand;
}

/**
 * One git command in `dir`. A non-zero exit is an answer here (git uses it for "no", "not yet",
 * "already merged"), so callers decide whether it is a failure.
 */
export function gitCall(ctx: GitContext, dir: string, args: string[], env?: Record<string, string>): Promise<CommandResult> {
  return ctx.run(ctx.gitBin, ['-C', dir, ...args], {
    env: { GIT_TERMINAL_PROMPT: '0', ...env },
  });
}

/** The same call when a non-zero exit is a failure: rejects with the command and git's own words. */
export async function gitText(
  ctx: GitContext,
  dir: string,
  args: string[],
  env?: Record<string, string>,
): Promise<string> {
  const result = await gitCall(ctx, dir, args, env);
  if (result.error !== undefined) {
    throw new Error(`git is not installed or not runnable (${ctx.gitBin}): ${result.error.message}`);
  }
  if (result.code !== 0) {
    throw new Error(`git -C ${dir} ${args.join(' ')} failed (exit ${result.code}): ${outputTail(result.stderr)}`);
  }
  return result.stdout;
}

/** Where a branch's worktree lives (§7.3): under `.worktrees/`, with `/` flattened out of the name. */
export function worktreePathFor(root: string, branch: string): string {
  return path.join(root, '.worktrees', branch.replace(/\//g, '-'));
}


/** git prints canonical paths; a temp directory on macOS is reached through a symlink. */
function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

// ── worktrees ─────────────────────────────────────────────────────────────────────────────

/** Every worktree git knows about, by path, with the branch it has checked out (null: detached). */
async function worktrees(ctx: GitContext, root: string): Promise<Map<string, string | null>> {
  const stdout = await gitText(ctx, root, ['worktree', 'list', '--porcelain']);
  const found = new Map<string, string | null>();
  let at: string | null = null;
  let branch: string | null = null;
  const record = (): void => {
    if (at !== null) found.set(realPath(at), branch);
    at = null;
    branch = null;
  };
  for (const line of stdout.split('\n')) {
    if (line === '') record();
    else if (line.startsWith('worktree ')) at = line.slice('worktree '.length);
    else if (line.startsWith('branch refs/heads/')) branch = line.slice('branch refs/heads/'.length);
    else if (line === 'detached') branch = null;
  }
  record();
  return found;
}

/**
 * `.worktrees/` belongs to bdc, not to the repo: ignore it in the clone's own exclude file, never
 * in the repo's `.gitignore` (§7.3). Idempotent: a directory that is already ignored is left alone.
 */
async function ignoreWorktrees(ctx: GitContext, root: string): Promise<void> {
  // A path inside the directory, because `check-ignore` matches paths and the directory itself may
  // not exist yet.
  const ignored = (await gitCall(ctx, root, ['check-ignore', '--quiet', '.worktrees/bdc-probe'])).code === 0;
  if (ignored) return;
  const gitPath = (await gitText(ctx, root, ['rev-parse', '--git-path', 'info/exclude'])).trim();
  const file = path.resolve(root, gitPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const separator = before === '' || before.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${separator}.worktrees/\n`);
}

/** Creates the branch (from `base`, if missing) and its worktree (if missing); reuses both. */
async function ensureWorktree(ctx: GitContext, input: EnsureWorktreeInput): Promise<EnsureWorktreeOutput> {
  const { root, branch, base } = input;
  const worktree = worktreePathFor(root, branch);
  await ignoreWorktrees(ctx, root);

  const ref = branch;
  const exists = (await gitCall(ctx, root, ['show-ref', '--verify', '--quiet', `refs/heads/${ref}`])).code === 0;
  if (!exists) await gitText(ctx, root, ['branch', ref, base]);

  const listed = await worktrees(ctx, root);
  const current = listed.get(realPath(worktree));
  if (current === undefined) {
    if (fs.existsSync(worktree)) {
      throw new Error(`${worktree} already exists and is not a worktree bdc made for ${branch}; bdc will not use it`);
    }
    await gitText(ctx, root, ['worktree', 'add', worktree, ref]);
  } else if (current !== ref) {
    throw new Error(`the worktree at ${worktree} has ${current ?? 'a detached HEAD'} checked out, not ${ref}`);
  }

  const head = (await gitText(ctx, worktree, ['rev-parse', 'HEAD'])).trim();
  return { path: worktree, head };
}

// ── merging ───────────────────────────────────────────────────────────────────────────────

/** `git merge-base --is-ancestor`: exit 0 means yes, 1 means no. */
async function isAncestor(ctx: GitContext, dir: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await gitCall(ctx, dir, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

/** Commits bdc makes use the repo's identity; a repo without one gets bdc's own, for these calls only. */
async function identityArgs(ctx: GitContext, dir: string): Promise<string[]> {
  const email = await gitCall(ctx, dir, ['config', 'user.email']);
  const name = await gitCall(ctx, dir, ['config', 'user.name']);
  const configured = email.code === 0 && email.stdout.trim() !== '' && name.code === 0 && name.stdout.trim() !== '';
  return configured ? [] : ['-c', 'user.name=bdc', '-c', 'user.email=bdc@localhost'];
}

function mergeFailure(into: string, from: string, result: CommandResult): string {
  return `merging ${from} into ${into} stopped: ${outputTail(result.stderr)}. bdc does not throw away changes in a worktree; commit or stash them and try again`;
}

/**
 * Merges `from` into the worktree at `into`: fast-forward when it can, else a merge commit, and a
 * conflict is aborted with the files it was in (§7.3). `into` is a worktree path, `from` a branch.
 */
async function mergeBranch(ctx: GitContext, input: MergeBranchInput): Promise<MergeBranchOutput> {
  const { into } = input;
  // The commit message names the branch the way bdc and the person name it, not the ref it lives in.
  const from = input.from;
  const head = async (): Promise<string> => (await gitText(ctx, into, ['rev-parse', 'HEAD'])).trim();

  // Already merged: a restored run asks again, and the answer is the head it has (§5.7).
  if (await isAncestor(ctx, into, from, 'HEAD')) return { merged: true, head: await head() };

  if (await isAncestor(ctx, into, 'HEAD', from)) {
    const fastForward = await gitCall(ctx, into, ['merge', '--ff-only', from]);
    if (fastForward.code === 0) return { merged: true, head: await head() };
    throw new Error(mergeFailure(into, from, fastForward));
  }

  const identity = await identityArgs(ctx, into);
  const merge = await gitCall(ctx, into, [...identity, 'merge', '--no-ff', '--no-edit', '-m', `bdc: merge ${input.from}`, from]);
  if (merge.code === 0) return { merged: true, head: await head() };

  // A conflict leaves MERGE_HEAD behind. Anything else (local changes in the way) left the worktree
  // as it was, and that is not bdc's to resolve.
  const inProgress = (await gitCall(ctx, into, ['rev-parse', '--quiet', '--verify', 'MERGE_HEAD'])).code === 0;
  if (!inProgress) throw new Error(mergeFailure(into, from, merge));

  const conflicts = (await gitText(ctx, into, ['diff', '--name-only', '--diff-filter=U']))
    .split('\n')
    .filter((file) => file.trim() !== '');
  await gitText(ctx, into, ['merge', '--abort']);
  return { merged: false, conflicts };
}

// ── commits ───────────────────────────────────────────────────────────────────────────────

/**
 * `--format=%H --name-only` prints a commit's sha on a line of its own and then the files it
 * touched; the next commit's sha follows the last file with only a newline between them. So a line
 * that is a whole sha opens a commit and every other line is one of its files. (A file whose name
 * is exactly 40 hex characters would be read as a commit; no real tree has one.)
 */
function parseLog(stdout: string): Array<{ sha: string; files: string[] }> {
  const commits: Array<{ sha: string; files: string[] }> = [];
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    if (/^[0-9a-f]{40}$/.test(line)) commits.push({ sha: line, files: [] });
    else commits[commits.length - 1]?.files.push(line);
  }
  return commits;
}

/** The commits on `branch` after `base`, newest first, with the files each touched (§4.4). */
async function commitsSince(ctx: GitContext, input: CommitsSinceInput): Promise<CommitsSinceOutput> {
  const range = `${input.base}..${input.branch}`;
  const stdout = await gitText(ctx, input.root, ['log', '--format=%H', '--name-only', range]);
  return { commits: parseLog(stdout) };
}

// ── the effects ───────────────────────────────────────────────────────────────────────────

export interface GitEffectsOptions {
  /** The git binary. The tests run the real one against throwaway repositories. */
  gitBin?: string;
  run?: RunCommand;
}

export interface GitEffects {
  ensureWorktree: PromiseActorLogic<EnsureWorktreeOutput, EnsureWorktreeInput>;
  mergeBranch: PromiseActorLogic<MergeBranchOutput, MergeBranchInput>;
  commitsSince: PromiseActorLogic<CommitsSinceOutput, CommitsSinceInput>;
}

/** The three git actors the phase machine invokes (§5.3). */
export function gitEffects(options: GitEffectsOptions = {}): GitEffects {
  const ctx: GitContext = { gitBin: options.gitBin ?? 'git', run: options.run ?? runProcess };
  return {
    ensureWorktree: fromPromise<EnsureWorktreeOutput, EnsureWorktreeInput>(({ input }) => ensureWorktree(ctx, input)),
    mergeBranch: fromPromise<MergeBranchOutput, MergeBranchInput>(({ input }) => mergeBranch(ctx, input)),
    commitsSince: fromPromise<CommitsSinceOutput, CommitsSinceInput>(({ input }) => commitsSince(ctx, input)),
  };
}
