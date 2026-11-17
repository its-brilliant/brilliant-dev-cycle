/**
 * The `bdc` commands (spec §7.2). Each one talks to the project's daemon over the socket and
 * writes through the injected io, so `main` stays testable and nothing here calls `process.exit`.
 * `start` and `daemon` are the slice-1 additions: one creates a run, the other is the daemon itself.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { PM_KINDS, serveMcp } from '../agents/mcp-server.js';
import { envFromProcess, isSubmitKind, submit as submitToInbox } from '../agents/submit.js';
import { SUBMIT_TOOLS } from '../contracts/actors.js';
import { ProjectConfig } from '../contracts/domain.js';
import { connect, ensureDaemon, newRequestId, type DaemonClient } from '../daemon/client.js';
import { latestRunId, projectPaths } from '../daemon/paths.js';
import { ProjectRuns } from '../daemon/runs.js';
import { startDaemon } from '../daemon/server.js';
import { realEffects } from '../effects/real.js';
import { scriptedActors } from '../effects/scripted.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Aborting ends `bdc watch` and `bdc daemon` so `main` can return. */
  signal?: AbortSignal;
}

/** The person got the command line wrong; `main` answers with the usage and exit code 2. */
export class UsageError extends Error {}

export const USAGE = `usage:
  bdc start <dir> "<goal>"
  bdc daemon <dir> [--scripted]   (real agents unless --scripted)
  bdc send <dir> <EVENT_TYPE> [json-payload] [--run <id>]
  bdc status <dir> [--run <id>]
  bdc runs <dir>
  bdc watch <dir> [--run <id>]
  bdc mcp
  bdc submit <kind> [json | --file <path>]

Starts runs and the project daemon, sends person events and prints run views (spec §7.2).
Without --run a command uses the project's latest run.
\`bdc mcp\` is the MCP server bdc attaches to an agent, and \`bdc submit\` the same submission for
a CLI without MCP; both read the AGENT_ENV bdc starts the agent with, so they only work inside a job.`;

/** What `bdc start` prints when the project has no `bdc.yaml` yet. */
const EXAMPLE_CONFIG = `agents:
  pm: { cli: pi, model: '' }
  specWriter: { cli: pi, model: '' }
  planner: { cli: pi, model: '' }
  builder: { cli: pi, model: '' }
  reviewer: { cli: pi, model: '' }
  verifier: { cli: pi, model: '' }
verification:
  checks:
    - run: npm test`;

/** Send one person event. Silence on success: the caller sees the effect in `status`/`watch`. */
export async function send(args: string[]): Promise<number> {
  const { positional, flags } = parseArgs(args, ['run']);
  if (positional.length > 3) throw new UsageError('send takes a directory, an event type and at most one JSON payload');
  const dir = requireDir(positional[0], 'send');
  const eventType = positional[1];
  if (eventType === undefined) throw new UsageError('send needs an event type, e.g. bdc send . SPEC_APPROVED');
  const event = { type: eventType, ...payloadObject(positional[2]) };
  const runId = flags.run ?? requireLatestRun(dir);

  const client = await connectToDaemon(dir);
  try {
    const response = await client.request({ id: newRequestId(), type: 'send', runId, event });
    if (!response.ok) throw new Error(`the daemon refused the event: ${response.error}`);
    return 0;
  } finally {
    client.close();
  }
}

export async function status(args: string[], io: CliIO): Promise<number> {
  const { positional, flags } = parseArgs(args, ['run']);
  if (positional.length > 1) throw new UsageError('status takes one project directory');
  const dir = requireDir(positional[0], 'status');
  const runId = flags.run ?? requireLatestRun(dir);

  const client = await connectToDaemon(dir);
  try {
    const response = await client.request({ id: newRequestId(), type: 'view', runId });
    if (!response.ok) throw new Error(`the daemon refused the view request: ${response.error}`);
    io.out(`${JSON.stringify(response.view, null, 2)}\n`);
    return 0;
  } finally {
    client.close();
  }
}

export async function runs(args: string[], io: CliIO): Promise<number> {
  const { positional } = parseArgs(args, []);
  if (positional.length > 1) throw new UsageError('runs takes one project directory');
  const dir = requireDir(positional[0], 'runs');

  const client = await connectToDaemon(dir);
  try {
    const response = await client.request({ id: newRequestId(), type: 'runs' });
    if (!response.ok) throw new Error(`the daemon refused the run list: ${response.error}`);
    for (const run of response.runs ?? []) io.out(`${JSON.stringify(run)}\n`);
    return 0;
  } finally {
    client.close();
  }
}

/** Print one view per line until the daemon goes away or the caller aborts (Ctrl-C, a test). */
export async function watch(args: string[], io: CliIO): Promise<number> {
  const { positional, flags } = parseArgs(args, ['run']);
  if (positional.length > 1) throw new UsageError('watch takes one project directory');
  const dir = requireDir(positional[0], 'watch');
  const runId = flags.run ?? requireLatestRun(dir);

  const client = await connectToDaemon(dir);
  try {
    await client.subscribe(runId, (view) => io.out(`${JSON.stringify(view)}\n`));
    await untilStopped(client, io.signal);
    return 0;
  } finally {
    client.close();
  }
}

/**
 * `bdc start <dir> "<goal>"`: read the project's `bdc.yaml`, make sure the daemon is up, create the
 * run and print its id.
 *
 * The run is created here, in the CLI process, and not over the socket: `server.ts` has no request
 * that creates a run, and it is not this slice's file. The daemon adopts a run directory it did not
 * create on the first request that names it (see `ProjectRuns.hostFor`), so the run continues in
 * the daemon as soon as anything looks at it.
 */
export async function start(args: string[], io: CliIO): Promise<number> {
  const scripted = args.includes('--scripted');
  const { positional } = parseArgs(args.filter((arg) => arg !== '--scripted'), []);
  if (positional.length !== 2) throw new UsageError('start takes a project directory and a goal');
  const root = path.resolve(requireDir(positional[0], 'start'));
  const goal = positional[1] ?? '';
  if (goal.trim() === '') throw new UsageError('start needs a goal, in quotes');
  const config = readProjectConfig(path.join(root, 'bdc.yaml'));

  await ensureDaemon(root, () => spawnDaemon(root, scripted));
  // Only the run's input is written here; the daemon starts it, so no agent is launched from this
  // short-lived process (§7.1).
  const runs = new ProjectRuns(root, { effects: (input) => scriptedActors({ goal: input.goal }) });
  const runId = runs.prepare(goal, config);
  const client = await connect(root);
  try {
    const adopted = await client.request({ id: newRequestId(), type: 'view', runId });
    if (!adopted.ok) throw new Error(`the daemon did not take run ${runId}: ${adopted.error ?? 'no answer'}`);
  } finally {
    client.close();
  }
  io.out(`${runId}\n`);
  return 0;
}

/**
 * `bdc daemon <dir> [--scripted]`: the project's daemon, in the foreground, until Ctrl-C (§7.1).
 * Real agents by default; `--scripted` runs every agent as a deterministic stand-in.
 */
export async function daemon(args: string[], io: CliIO): Promise<number> {
  const positional: string[] = [];
  let scripted = false;
  for (const arg of args) {
    if (arg === '--scripted') scripted = true;
    else if (arg.startsWith('--')) throw new UsageError(`unknown option: ${arg}`);
    else positional.push(arg);
  }
  if (positional.length > 1) throw new UsageError('daemon takes one project directory');
  const root = path.resolve(positional[0] ?? '.');

  const runs = new ProjectRuns(root, {
    effects: (input) => (scripted ? scriptedActors({ goal: input.goal }) : realEffects(input)),
  });
  const restored = runs.restoreAll();
  const server = await startDaemon({ root: runs.root, hostFor: (runId) => runs.hostFor(runId), runs: () => runs.runs() });
  const restoredNote = restored.length === 0 ? '' : `, restored ${restored.join(', ')}`;
  io.out(`bdc daemon for ${runs.root} on ${server.socket}${restoredNote}\n`);
  try {
    await untilSignal(io.signal);
    return 0;
  } finally {
    await server.stopDaemon();
    runs.stop();
  }
}

/** `bdc mcp`: the job's MCP server over stdio, until the agent CLI closes the pipe (§3.4). */
export async function mcp(args: string[]): Promise<number> {
  const { positional } = parseArgs(args, []);
  if (positional.length > 0) throw new UsageError('mcp takes no arguments');
  await serveMcp(envFromProcess());
  return 0;
}

/**
 * `bdc submit <kind> [json | --file <path>]`, stdin when neither: the same `submit` the MCP tool calls,
 * for a CLI without MCP and for tests. It answers with the new entry's seq or with the problems.
 */
export async function submit(args: string[], io: CliIO): Promise<number> {
  const { positional, flags } = parseArgs(args, ['file']);
  if (positional.length > 2) throw new UsageError('submit takes a submission kind and at most one JSON payload');
  const kind = positional[0];
  if (kind === undefined) throw new UsageError(`submit needs a submission kind (${Object.keys(SUBMIT_TOOLS).join(', ')})`);
  if (!isSubmitKind(kind)) {
    throw new UsageError(`submit does not know the kind "${kind}"; it takes ${Object.keys(SUBMIT_TOOLS).join(', ')}`);
  }
  if (flags.file !== undefined && positional[1] !== undefined) {
    throw new UsageError('submit takes the payload as JSON or from --file, not both');
  }
  const env = envFromProcess();
  // A job submits its own kind; a PM session submits any of the PM's kinds (§5.4).
  const allowed = PM_KINDS.includes(env.kind) ? PM_KINDS : [env.kind];
  if (!allowed.includes(kind)) throw new Error(`this job submits ${allowed.join(' or ')}, not ${kind}`);
  const target = { ...env, kind };

  const read = readSubmission(flags.file, positional[1], io);
  if (!read.ok) return 1;
  const result = submitToInbox(target, read.payload);
  if (!result.ok) {
    io.err(`bdc: the submission was rejected:\n${result.problems.map((problem) => `  ${problem}`).join('\n')}\n`);
    return 1;
  }
  io.out(`submitted #${result.seq}\n`);
  return 0;
}

/** The submission bdc reads: `ok` false means it was unreadable or not JSON, and `io` says why. */
interface ReadSubmission {
  ok: boolean;
  payload: unknown;
}

/** The submission from `--file`, the JSON argument, or stdin. */
function readSubmission(file: string | undefined, json: string | undefined, io: CliIO): ReadSubmission {
  const from = file !== undefined ? 'file' : json !== undefined ? 'the argument' : 'stdin';
  let text: string;
  try {
    text = file !== undefined ? fs.readFileSync(file, 'utf8') : (json ?? fs.readFileSync(0, 'utf8'));
  } catch (error) {
    io.err(`bdc: cannot read the submission from ${from}: ${message(error)}\n`);
    return { ok: false, payload: undefined };
  }
  try {
    return { ok: true, payload: JSON.parse(text) };
  } catch (error) {
    io.err(`bdc: the submission from ${from} is not JSON: ${message(error)}\n`);
    return { ok: false, payload: undefined };
  }
}

/** The project config, or a `UsageError` that says what to write instead. */
function readProjectConfig(file: string): ProjectConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new UsageError(
      `no bdc.yaml in ${path.dirname(file)}. \`bdc init\` comes in a later slice; write one by hand:\n\n${EXAMPLE_CONFIG}`,
    );
  }
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new UsageError(`bdc.yaml is not valid YAML: ${message(error)}`);
  }
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.') || 'bdc.yaml'}: ${issue.message}`);
    throw new UsageError(`bdc.yaml is not a project config: ${issues.join('; ')}`);
  }
  return parsed.data;
}

/** `dist/cli/bin.js`, next to this module, so a spawned daemon is the same build as the CLI. */
function cliBin(): string {
  return fileURLToPath(new URL('./bin.js', import.meta.url));
}

/** Start the daemon detached, its output in `.herd/daemon.log` (§7.1). A hidden hc terminal is slice 2. */
function spawnDaemon(root: string, scripted: boolean): void {
  const paths = projectPaths(root);
  fs.mkdirSync(paths.herd, { recursive: true });
  const log = fs.openSync(path.join(paths.herd, 'daemon.log'), 'a');
  try {
    const child = spawn(process.execPath, [cliBin(), 'daemon', paths.root, ...(scripted ? ['--scripted'] : [])], {
      detached: true,
      stdio: ['ignore', log, log],
    });
    child.unref();
  } finally {
    fs.closeSync(log);
  }
}

/** Resolve on Ctrl-C, SIGTERM or the caller's abort: the daemon runs until one of them. */
function untilSignal(signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off('SIGINT', done);
      process.off('SIGTERM', done);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}

function untilStopped(client: DaemonClient, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      stopListening();
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const stopListening = client.onClose(done);
    if (signal?.aborted) done();
    else signal?.addEventListener('abort', done, { once: true });
  });
}

/** `--name value` and `--name=value`; anything else that starts with `--` is a mistake worth naming. */
function parseArgs(args: string[], valueFlags: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--') {
      positional.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const equals = body.indexOf('=');
    const name = equals >= 0 ? body.slice(0, equals) : body;
    if (!valueFlags.includes(name)) throw new UsageError(`unknown option: ${arg}`);
    const value = equals >= 0 ? body.slice(equals + 1) : args[index + 1];
    if (value === undefined) throw new UsageError(`${arg} needs a value`);
    flags[name] = value;
    if (equals < 0) index += 1;
  }
  return { positional, flags };
}

function payloadObject(payload: string | undefined): Record<string, unknown> {
  if (payload === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new UsageError(`the payload is not JSON: ${message(error)}`);
  }
  if (!isRecord(parsed)) throw new UsageError('the payload must be a JSON object');
  return parsed;
}

function requireDir(dir: string | undefined, command: string): string {
  if (dir === undefined) throw new UsageError(`${command} needs the project directory`);
  return dir;
}

function requireLatestRun(dir: string): string {
  const runId = latestRunId(dir);
  if (runId === null) throw new Error(`no runs in ${projectPaths(dir).root} yet; pass --run <id>`);
  return runId;
}

async function connectToDaemon(dir: string): Promise<DaemonClient> {
  try {
    return await connect(dir);
  } catch (error) {
    throw new Error(`no bdc daemon is running for ${projectPaths(dir).root}: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
