/**
 * The real verification effect (spec §7.4): bring the repo into a testable state in one worktree,
 * run the repo's checks and the phase's own, and always clean up.
 *
 * Everything a person needs to judge a failed verification is kept: each step's whole output goes
 * to `<worktree>/.bdc-proof/<phase>/verify-<n>-<name>.log`, and the last 4000 characters ride along
 * in the `StepResult` the Phase and Verify screens show (§7.4).
 *
 * Three things the machines rely on:
 * - **A re-run starts from scratch.** A marker file says an earlier attempt was still running when
 *   the daemon died or the run was restored; that attempt's teardown runs before this one starts,
 *   so containers and databases are not left behind for the next attempt to trip over (§5.7).
 * - **Teardown always runs**, also after a setup failure and after a timeout (§7.4).
 * - **`.bdc-proof/` can never be committed.** It is added to the repository's `info/exclude`, which
 *   lives in the git common dir, so every worktree of the repo inherits it and no phase branch ever
 *   sees the logs as untracked files.
 *
 * The whole verification is bounded by `setup.timeout` seconds: the running step's process group
 * is killed and recorded as failed with "timed out". Teardown gets a fresh budget of the same
 * length, because cleanup still has to happen after the verification itself ran out of time.
 */
import { execFileSync, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fromPromise } from 'xstate';
import type { PromiseActorLogic } from 'xstate';

import type { RunVerificationInput, RunVerificationOutput, StepResult } from '../contracts/actors.js';

/** Where verification keeps what it captured; excluded from git, never committed. */
const PROOF_DIR = '.bdc-proof';
/** The output tail a `StepResult` carries; the whole output is in the log file. */
const OUTPUT_TAIL_CHARS = 4000;
/** §7.4's default when the setup does not say: half an hour for the whole verification. */
const DEFAULT_TIMEOUT_SECONDS = 1800;
/** §7.4: slot 0 gets 20000-20099, slot 1 20100-20199, … unless the caller moves the range. */
const DEFAULT_PORT_BASE = 20000;
const PORTS_PER_SLOT = 100;
/** §7.4: the ready check is retried every second. */
const READY_RETRY_MS = 1000;

export interface VerifyOptions {
  /** §7.4's `BDC_PORT_BASE` for slot 0. Slot `n` gets `portBase + n * 100`. */
  portBase?: number;
}

/** One command of the setup: a name for people, and the `sh -c` line that runs it. */
interface Step {
  name?: string;
  run: string;
}

interface CommandResult {
  /** The step's exit code, or null when it was killed. */
  exitCode: number | null;
  /** stdout and stderr, interleaved as they arrived. */
  output: string;
  timedOut: boolean;
}

/** `runVerification` (§7.4): setup → ready → checks → teardown, in the phase's worktree. */
export function verifyEffect(options: VerifyOptions = {}): PromiseActorLogic<RunVerificationOutput, RunVerificationInput> {
  const portBase = options.portBase ?? DEFAULT_PORT_BASE;
  return fromPromise(async ({ input }) => verify(input, portBase));
}

async function verify(input: RunVerificationInput, portBase: number): Promise<RunVerificationOutput> {
  const setup = input.setup;
  const checks: Step[] = [...(setup?.checks ?? []), ...input.extraChecks];
  // Nothing to run is a pass, and leaves no trace in the worktree: a repo with no verification
  // setup and a phase with no checks must not grow a `.bdc-proof/` folder.
  if (setup === null && checks.length === 0) return { passed: true, steps: [], proofFiles: [] };

  const timeoutSeconds = setup?.timeout ?? DEFAULT_TIMEOUT_SECONDS;
  const logDir = path.join(input.worktree, PROOF_DIR, slug(input.phaseId));
  fs.mkdirSync(logDir, { recursive: true });
  excludeFromGit(input.worktree);

  const runner = new Runner({ worktree: input.worktree, env: stepEnv(input, portBase), logDir, timeoutSeconds });
  const marker = path.join(logDir, 'running');

  // A marker means the previous attempt never finished: tear its environment down before starting.
  if (fs.existsSync(marker)) {
    runner.restartClock();
    await runner.run('teardown', setup?.teardown ?? []);
    fs.rmSync(marker, { force: true });
  }

  fs.writeFileSync(marker, `bdc verification ${input.runId} ${input.phaseId} slot ${input.slot}\n`);
  let failedAt: RunVerificationOutput['failedAt'];
  try {
    if (setup !== null) {
      if (!(await runner.run('setup', setup.setup, true))) failedAt = 'setup';
      // Checks against an environment that never came up say nothing, so a setup failure stops
      // here: the phase asks the PM about the setup instead (`failedAt: 'setup'`, §6).
      if (failedAt === undefined && setup.ready !== undefined && !(await runner.ready(setup.ready, setup.ready.timeout))) {
        failedAt = 'ready';
      }
    }
    if (failedAt === undefined && !(await runner.run('check', checks))) failedAt = 'check';
  } finally {
    // §7.4: teardown always runs, pass or fail. All of its steps run too: one failed cleanup step
    // must not leave the rest of the mess behind, and a cleanup failure is recorded but does not
    // change `passed` (the phase already passed or already failed on its own merits).
    runner.restartClock();
    await runner.run('teardown', setup?.teardown ?? []);
    fs.rmSync(marker, { force: true });
  }

  return {
    passed: failedAt === undefined,
    ...(failedAt === undefined ? {} : { failedAt }),
    steps: runner.steps,
    proofFiles: runner.proofFiles(),
  };
}

interface RunnerOptions {
  worktree: string;
  env: Record<string, string>;
  logDir: string;
  timeoutSeconds: number;
}

/** One verification's steps: runs them, times them, writes their logs, and keeps the deadline. */
class Runner {
  /** Every step, in the order it ran: what the phase shows and what the PR quotes (§4.6). */
  readonly steps: StepResult[] = [];
  /** Each step's log, relative to the worktree; `proofFiles()` puts them in proof order. */
  readonly logs: Array<{ phase: StepResult['phase']; file: string }> = [];
  #count = 0;
  #deadline: number;
  readonly #options: RunnerOptions;

  constructor(options: RunnerOptions) {
    this.#options = options;
    this.#deadline = Date.now() + options.timeoutSeconds * 1000;
  }

  /** Teardown gets a fresh budget: cleanup still has to happen after the verification timed out. */
  restartClock(): void {
    this.#deadline = Date.now() + this.#options.timeoutSeconds * 1000;
  }

  /** Runs a phase's steps; `stopOnFailure` is setup's rule ("stop at the first failure"). */
  async run(phase: StepResult['phase'], steps: Step[], stopOnFailure = false): Promise<boolean> {
    let passed = true;
    for (const step of steps) {
      if (!(await this.#step(phase, step))) {
        passed = false;
        if (stopOnFailure) return false;
      }
    }
    return passed;
  }

  /** Retries the ready check every second until it passes or `timeoutSeconds` are gone (§7.4). */
  async ready(step: Step, timeoutSeconds: number): Promise<boolean> {
    const until = Date.now() + timeoutSeconds * 1000;
    for (;;) {
      if (await this.#step('ready', step)) return true;
      if (Date.now() >= until || Date.now() >= this.#deadline) return false;
      await sleep(READY_RETRY_MS);
    }
  }

  /**
   * The logs as proof, checks first: the phase pairs `proofFiles` with its bdc proof requirements
   * in order (`collectBdcProof` in src/machines/phase.ts), and the first of those is almost always
   * `tests`, which a check log answers. A setup or ready log is the natural `log` proof; teardown's
   * noise comes last. `sort` is stable, so steps keep their order inside a phase.
   */
  proofFiles(): string[] {
    const order: Record<StepResult['phase'], number> = { check: 0, setup: 1, ready: 1, teardown: 2 };
    return [...this.logs].sort((a, b) => order[a.phase] - order[b.phase]).map((log) => log.file);
  }

  async #step(phase: StepResult['phase'], step: Step): Promise<boolean> {
    const command = step.run;
    const name = step.name ?? command;
    this.#count += 1;
    const startedAt = Date.now();
    const remainingMs = this.#deadline - startedAt;
    const note = `bdc: timed out after ${this.#options.timeoutSeconds}s (the verification's own limit); the step was killed.`;
    const result: CommandResult =
      remainingMs <= 0
        ? { exitCode: null, output: `${note}\n`, timedOut: true }
        : await runCommand(command, { cwd: this.#options.worktree, env: this.#options.env, timeoutMs: remainingMs, note });
    const durationMs = Date.now() - startedAt;
    const file = path.join(this.#options.logDir, `verify-${this.#count}-${slug(name)}.log`);
    fs.writeFileSync(file, `$ ${command}\n\n${result.output}`);
    this.steps.push({ phase, name, command, exitCode: result.exitCode, durationMs, outputTail: tail(result.output) });
    this.logs.push({ phase, file: path.relative(this.#options.worktree, file) });
    return !result.timedOut && result.exitCode === 0;
  }
}

/** `sh -c` in the worktree, its output kept whole, its process group killed when time is up. */
function runCommand(
  command: string,
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; note: string },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', command], {
      cwd: options.cwd,
      env: options.env,
      // Its own process group, so a timeout kills what the step started as well as the shell
      // (`npm test` runs node, `docker compose up` runs docker; both would survive the shell).
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: string[] = [];
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) chunks.push(`\n${options.note}\n`);
      resolve({ exitCode, output: chunks.join(''), timedOut });
    };
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.on('error', (error: Error) => {
      chunks.push(`bdc: could not run the step: ${error.message}\n`);
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
    timer = setTimeout(() => {
      timedOut = true;
      killGroup(child);
    }, Math.max(1, options.timeoutMs));
  });
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    // A negative pid is the whole group the detached shell started.
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * The environment every step gets (§7.4): the daemon's own environment, then the setup's `env`
 * with `${VAR}` filled in from bdc's variables, then bdc's variables themselves — so a repo can
 * build `DATABASE_URL: postgres://localhost:${BDC_PORT_BASE}/app` and cannot shadow `BDC_SLOT`.
 * A `${VAR}` bdc does not know is left as written, so the step fails loudly instead of silently
 * using an empty string.
 */
function stepEnv(input: RunVerificationInput, portBase: number): Record<string, string> {
  const bdc: Record<string, string> = {
    BDC_WORKTREE: input.worktree,
    BDC_PHASE: input.phaseId,
    BDC_RUN: input.runId,
    BDC_SLOT: String(input.slot),
    BDC_PORT_BASE: String(portBase + input.slot * PORTS_PER_SLOT),
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) if (value !== undefined) env[name] = value;
  for (const [name, value] of Object.entries(input.setup?.env ?? {})) env[name] = expand(value, bdc);
  return { ...env, ...bdc };
}

function expand(value: string, variables: Record<string, string>): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) => variables[name] ?? whole);
}

/**
 * Adds `.bdc-proof/` to the repository's `info/exclude`, which lives in the git common dir and is
 * therefore shared by every worktree of the repo. A worktree that is not a git repo (or a machine
 * without git) is not an error: the logs simply stay untracked.
 */
function excludeFromGit(worktree: string): void {
  let commonDir: string;
  try {
    commonDir = execFileSync('git', ['-C', worktree, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return;
  }
  const file = path.join(path.resolve(worktree, commonDir), 'info', 'exclude');
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (current.split('\n').some((line) => line.trim() === `${PROOF_DIR}/`)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lead = current === '' || current.endsWith('\n') ? '' : '\n';
  fs.appendFileSync(file, `${lead}# bdc verification logs (§7.4): never commit them\n${PROOF_DIR}/\n`);
}

/** A step name as a file name: lowercase, dashes, short, never empty and never a path. */
function slug(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return cleaned === '' ? 'step' : cleaned;
}

function tail(output: string): string {
  return output.length <= OUTPUT_TAIL_CHARS ? output : output.slice(-OUTPUT_TAIL_CHARS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
