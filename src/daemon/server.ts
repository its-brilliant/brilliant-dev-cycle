/**
 * The daemon's socket (spec §7.1, §7.2). It owns no run state itself: it answers the wire protocol
 * from `client.ts` by asking the `RunHost`s and the run list the caller hands it, so tests and
 * slice 2 can drive it with any machines.
 */
import fs from 'node:fs';
import net from 'node:net';
import { pingSocket, type DaemonResponse, type RunSummary } from './client.js';
import type { RunHost } from './host.js';
import { clearSocketPathRecord, projectPaths, recordSocketPath, type ProjectPaths } from './paths.js';
import type { JsonValue } from './store.js';

export interface DaemonOptions {
  /** Project root; the socket lives under its `.herd` (or in the temp dir when the path is too long). */
  root: string;
  /** The host for a run id, or undefined when this project has no such run. */
  hostFor: (runId: string) => RunHost | undefined;
  /** Every run id in the project. */
  runs: () => string[];
}

export interface Daemon {
  root: string;
  socket: string;
  /** Close the socket, drop clients and remove the socket file. */
  stopDaemon(): Promise<void>;
}

/** How long a ping may take before an existing socket file counts as stale. */
const STALE_PING_TIMEOUT_MS = 500;

export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  const paths = projectPaths(options.root);
  fs.mkdirSync(paths.herd, { recursive: true });
  await removeStaleSocket(paths);

  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    const stops: Array<() => void> = [];
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (line.trim() !== '') answer(socket, line, stops, options);
        newline = buffer.indexOf('\n');
      }
    });
    // A panel or CLI that goes away is normal, not a daemon problem.
    socket.on('error', () => undefined);
    socket.on('close', () => {
      for (const stop of stops) stop();
      sockets.delete(socket);
    });
  });

  await listen(server, paths.socket);
  if (paths.socket !== paths.defaultSocket) recordSocketPath(paths);

  return {
    root: paths.root,
    socket: paths.socket,
    async stopDaemon(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await close(server);
      fs.rmSync(paths.socket, { force: true });
      clearSocketPathRecord(paths);
    },
  };
}

/** One line in, at most one answer plus any streamed views. Never throws: a bad line is an error reply. */
function answer(socket: net.Socket, line: string, stops: Array<() => void>, options: DaemonOptions): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (error) {
    write(socket, { id: null, ok: false, error: `malformed request: ${message(error)}` });
    return;
  }
  if (!isRecord(parsed) || typeof parsed.id !== 'string' || typeof parsed.type !== 'string') {
    write(socket, { id: null, ok: false, error: 'a request needs a string id and type' });
    return;
  }
  const id = parsed.id;
  try {
    const response = handle(socket, id, parsed, stops, options);
    if (response) write(socket, response);
  } catch (error) {
    write(socket, { id, ok: false, error: message(error) });
  }
}

function handle(
  socket: net.Socket,
  id: string,
  request: Record<string, unknown>,
  stops: Array<() => void>,
  options: DaemonOptions,
): DaemonResponse | undefined {
  switch (request.type) {
    case 'ping':
      return { id, ok: true, pong: true };

    case 'runs':
      return { id, ok: true, runs: options.runs().map((runId) => summary(runId, options.hostFor(runId))) };

    case 'send': {
      const host = hostOf(request.runId, options);
      if (host instanceof Error) return { id, ok: false, error: host.message };
      const result = host.send(request.event);
      return result.ok ? { id, ok: true } : { id, ok: false, error: result.error };
    }

    case 'view': {
      const host = hostOf(request.runId, options);
      if (host instanceof Error) return { id, ok: false, error: host.message };
      return { id, ok: true, view: host.view };
    }

    case 'subscribe': {
      const host = hostOf(request.runId, options);
      if (host instanceof Error) return { id, ok: false, error: host.message };
      const runId = String(request.runId);
      // Acknowledge first, then stream: the host hands over the current view immediately.
      write(socket, { id, ok: true });
      stops.push(host.onView((view) => write(socket, { type: 'view', runId, view })));
      return undefined;
    }

    default:
      return { id, ok: false, error: `unknown request type: ${String(request.type)}` };
  }
}

function hostOf(runId: unknown, options: DaemonOptions): RunHost | Error {
  if (typeof runId !== 'string' || runId === '') return new Error('a request needs a runId');
  const host = options.hostFor(runId);
  return host ?? new Error(`unknown run: ${runId}`);
}

function summary(runId: string, host: RunHost | undefined): RunSummary {
  const view = host?.view;
  return { runId, stage: isRecord(view) && typeof view.stage === 'string' ? view.stage : null };
}

function write(socket: net.Socket, message: DaemonResponse | { type: 'view'; runId: string; view: JsonValue | undefined }): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(`${JSON.stringify(message)}\n`);
}

/** Refuse to start twice on one project; a socket file nobody answers on is a leftover to remove. */
async function removeStaleSocket(paths: ProjectPaths): Promise<void> {
  if (!fs.existsSync(paths.socket)) return;
  if (await pingSocket(paths.socket, STALE_PING_TIMEOUT_MS)) {
    throw new Error(`a bdc daemon is already running for ${paths.root} on ${paths.socket}`);
  }
  fs.rmSync(paths.socket, { force: true });
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(socketPath, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
