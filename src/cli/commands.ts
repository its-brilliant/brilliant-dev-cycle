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
import { runChat, streamTerminal } from './chat.js';
import { defaultConfig, parseConfigJson, writeProjectConfig } from './init.js';
import { connect, ensureDaemon, newRequestId, type DaemonClient } from '../daemon/client.js';
import { latestRunId, projectPaths } from '../daemon/paths.js';
import { ProjectRuns } from '../daemon/runs.js';
import type { RunInput } from '../machines/run.js';
import { startDaemon } from '../daemon/server.js';
import { closeRunTerminals } from '../effects/hc.js';
import { realEffects } from '../effects/real.js';
import { scriptedActors } from '../effects/scripted.js';
import { checkMods, herdrPaths, installHerdr, repoRootFrom, stageForCheck, uninstallHerdr, type CheckReport } from '../herdr/install.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Aborting ends `bdc watch` and `bdc daemon` so `main` can return. */
  signal?: AbortSignal;
}

/** The person got the command line wrong; `main` answers with the usage and exit code 2. */
export class UsageError extends Error {}

export const USAGE = `usage:
  bdc init <dir> --config <json> | --print-defaults [--force]
  bdc start <dir> "<goal>"
  bdc daemon <dir> [--scripted]   (real agents unless --scripted)
  bdc chat <dir> [--run <id>]
  bdc say <dir> "<text>" [--run <id>]
  bdc send <dir> <EVENT_TYPE> [json-payload] [--run <id>]
  bdc status <dir> [--run <id>]
  bdc runs <dir>
  bdc watch <dir> [--run <id>]
  bdc mcp
  bdc submit <kind> [json | --file <path>]
  bdc herdr install|uninstall|check

\`bdc init\` writes the project's bdc.yaml from a config as JSON, or prints the starting config
with --print-defaults. Starts runs and the project daemon, sends person events and prints run
views (spec §7.2). Without --run a command uses the project's latest run.
\`bdc chat\` is the PM chat and the question tool in a terminal: /quit leaves, /status says where the
run is. \`bdc say\` sends one message to the PM and exits.
\`bdc mcp\` is the MCP server bdc attaches to an agent, and \`bdc submit\` the same submission for
a CLI without MCP; both read the AGENT_ENV bdc starts the agent with, so they only work inside a job.
\`bdc herdr install\` puts the bdc layout and mods in your Herdr app, \`uninstall\` takes them out,
and \`check\` runs \`herdr-app check\` on every bdc mod (spec §9).`;

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

/**
 * `bdc init <dir> --config <json>` writes `<dir>/bdc.yaml`; `--print-defaults` prints the starting
 * config as JSON instead. The config is validated with `ProjectConfig` before anything is written,
 * and an existing `bdc.yaml` is only replaced with `--force` (spec §3.1, §7.4, §10).
 */
export async function init(args: string[], io: CliIO): Promise<number> {
  const printDefaults = args.includes('--print-defaults');
  const force = args.includes('--force');
  const { positional, flags } = parseArgs(
    args.filter((arg) => arg !== '--print-defaults' && arg !== '--force'),
    ['config'],
  );
  if (positional.length !== 1) throw new UsageError('init takes one project directory');
  const dir = requireDir(positional[0], 'init');
  if (printDefaults && flags.config !== undefined) {
    throw new UsageError('init takes --config or --print-defaults, not both');
  }
  if (printDefaults) {
    io.out(`${JSON.stringify(defaultConfig(), null, 2)}\n`);
    return 0;
  }
  const json = flags.config;
  if (json === undefined) throw new UsageError('init needs --config <json>, or --print-defaults for a starting config');
  const parsed = parseConfigJson(json);
  if (!parsed.ok) {
    io.err(`bdc: the config is not a project config:\n${parsed.problems.map((problem) => `  ${problem}`).join('\n')}\n`);
    return 1;
  }
  const written = writeProjectConfig(dir, parsed.config, { force });
  if (!written.ok) {
    io.err(`bdc: ${written.error}\n`);
    return 1;
  }
  io.out(`wrote ${written.file}\n`);
  return 0;
}

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

/**
 * `bdc chat <dir> [--run <id>]`: the PM chat and the question tool in a terminal (spec §3.4, §9.4),
 * until the Herdr panel exists. It only reads the view and sends person events; `chat.ts` runs it.
 */
export async function chat(args: string[], io: CliIO): Promise<number> {
  const { positional, flags } = parseArgs(args, ['run']);
  if (positional.length > 1) throw new UsageError('chat takes one project directory');
  const dir = requireDir(positional[0], 'chat');
  const runId = flags.run ?? requireLatestRun(dir);

  const client = await connectToDaemon(dir);
  const terminal = streamTerminal();
  try {
    return await runChat({
      client,
      runId,
      out: io.out,
      err: io.err,
      terminal,
      columns: process.stdout.columns,
      signal: io.signal,
    });
  } finally {
    terminal.close();
    client.close();
  }
}

/** `bdc say <dir> "<text>" [--run <id>]`: one message to the PM, then exit (spec §4.7). */
export async function say(args: string[], _io: CliIO): Promise<number> {
  const { positional, flags } = parseArgs(args, ['run']);
  if (positional.length > 2) throw new UsageError('say takes a project directory and one message');
  const dir = requireDir(positional[0], 'say');
  const text = positional[1]?.trim() ?? '';
  if (text === '') throw new UsageError('say needs a message, in quotes');
  const runId = flags.run ?? requireLatestRun(dir);

  const client = await connectToDaemon(dir);
  try {
    const event = { type: 'MESSAGE', text };
    const response = await client.request({ id: newRequestId(), type: 'send', runId, event });
    if (!response.ok) throw new Error(`the daemon refused the message: ${response.error}`);
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
    // §5.5: when a run ends, nothing of it keeps running, whatever its machines closed themselves.
    ...(scripted ? {} : { onRunEnded: (input: RunInput) => void closeRunTerminals(input.runId) }),
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

/**
 * `bdc herdr install | uninstall | check` (spec §9, §12.5): the bdc Herdr layout and mods.
 * `install` writes the files and then checks every mod it installed, `uninstall` removes exactly
 * those files, and `check` assembles the checkout's mods in a throwaway Herdr home and checks
 * them there, so neither the person's Herdr home nor their window is touched.
 */
export async function herdr(args: string[], io: CliIO): Promise<number> {
  const [subcommand, ...rest] = args;
  if (rest.length > 0) throw new UsageError(`herdr ${subcommand ?? ''} takes no arguments`);
  const repoRoot = repoRootFrom();

  switch (subcommand) {
    case 'install': {
      const installed = installHerdr({ repoRoot });
      for (const mod of installed.installed) io.out(`installed ${mod}\n`);
      for (const file of installed.layoutFiles) io.out(`installed ${file}\n`);
      io.out(
        installed.wrapper === null
          ? `left ${herdrPaths().wrapper} alone: it is not a bdc wrapper\n`
          : `wrote ${installed.wrapper}\n`,
      );
      const report = checkMods(installed.installed, { home: installed.home });
      printChecks(io, report);
      return report.ok ? 0 : 1;
    }
    case 'uninstall': {
      const { removed, kept } = uninstallHerdr({ repoRoot });
      for (const file of removed) io.out(`removed ${file}\n`);
      for (const file of kept) io.out(`kept ${file}: it is not a bdc wrapper\n`);
      if (removed.length === 0) io.out('nothing to remove\n');
      return 0;
    }
    case 'check': {
      const staged = stageForCheck({ repoRoot });
      try {
        const report = checkMods(staged.mods, { home: staged.home });
        printChecks(io, report);
        return report.ok ? 0 : 1;
      } finally {
        staged.cleanup();
      }
    }
    default:
      throw new UsageError('herdr takes install, uninstall or check');
  }
}

/** What `herdr-app check` said about each mod, in the order it ran. */
function printChecks(io: CliIO, report: CheckReport): void {
  for (const check of report.checks) {
    io.out(`${check.ok ? 'ok' : 'FAILED'}: ${path.basename(check.mod)}\n`);
    if (!check.ok) io.out(`${check.output}\n`);
  }
  io.out(report.ok ? 'every bdc mod loads\n' : 'a bdc mod did not load\n');
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
      `no bdc.yaml in ${path.dirname(file)}. Write one with \`bdc init ${path.dirname(file)} --print-defaults\` (piped to --config), or by hand:\n\n${EXAMPLE_CONFIG}`,
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
