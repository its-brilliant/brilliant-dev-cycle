/**
 * The four `bdc` commands (spec §7.2). Each one talks to the project's daemon over the socket and
 * writes through the injected io, so `main` stays testable and nothing here calls `process.exit`.
 */
import { connect, newRequestId, type DaemonClient } from '../daemon/client.js';
import { latestRunId, projectPaths } from '../daemon/paths.js';

export interface CliIO {
  out(text: string): void;
  err(text: string): void;
  /** Aborting ends `bdc watch` so `main` can return. */
  signal?: AbortSignal;
}

/** The person got the command line wrong; `main` answers with the usage and exit code 2. */
export class UsageError extends Error {}

export const USAGE = `usage:
  bdc send <dir> <EVENT_TYPE> [json-payload] [--run <id>]
  bdc status <dir> [--run <id>]
  bdc runs <dir>
  bdc watch <dir> [--run <id>]

Sends person events to the project's daemon and prints run views (spec §7.2).
Without --run a command uses the project's latest run.`;

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
