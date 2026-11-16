/**
 * The daemon's wire (spec §7.2): newline-delimited JSON over the project's unix socket. This module
 * is both ends' vocabulary — the request and response types live here, the server answers them —
 * and the client the CLI and the panels use.
 */
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { projectPaths } from './paths.js';
import type { JsonValue } from './store.js';

/** One run as `runs` reports it: the id, and the stage its view is in (null when it has no view yet). */
export interface RunSummary {
  runId: string;
  stage: string | null;
}

export type DaemonRequest =
  | { id: string; type: 'send'; runId: string; event: Record<string, unknown> }
  | { id: string; type: 'view'; runId: string }
  | { id: string; type: 'subscribe'; runId: string }
  | { id: string; type: 'runs' }
  | { id: string; type: 'ping' };

/** The answer to one request. `id` is null when the request could not even be read. */
export type DaemonResponse =
  | { id: string; ok: true; view?: JsonValue; runs?: RunSummary[]; pong?: true }
  | { id: string | null; ok: false; error: string };

/** An unsolicited line on a subscribed connection: one new view. */
export interface ViewMessage {
  type: 'view';
  runId: string;
  view: JsonValue;
}

export type DaemonMessage = DaemonResponse | ViewMessage;

export interface DaemonClient {
  readonly socket: string;
  request(request: DaemonRequest, timeoutMs?: number): Promise<DaemonResponse>;
  /** Stream this run's views (the current one first). The returned function stops local delivery. */
  subscribe(runId: string, onView: (view: JsonValue) => void): Promise<() => void>;
  /** Called when the daemon connection closes, so `bdc watch` can exit. */
  onClose(listener: () => void): () => void;
  close(): void;
}

export const DEFAULT_TIMEOUT_MS = 10_000;

export function newRequestId(): string {
  return randomUUID();
}

/** Connect to the project's daemon. Rejects when no daemon is listening there. */
export async function connect(root: string, options: { timeoutMs?: number } = {}): Promise<DaemonClient> {
  const { socket } = projectPaths(root);
  const client = await SocketClient.open(socket, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return client;
}

/** True when a daemon answers a ping on this socket. */
export async function pingSocket(socket: string, timeoutMs = 1_000): Promise<boolean> {
  let client: SocketClient;
  try {
    client = await SocketClient.open(socket, timeoutMs);
  } catch {
    return false;
  }
  try {
    const response = await client.request({ id: newRequestId(), type: 'ping' }, timeoutMs);
    return response.ok && response.pong === true;
  } catch {
    return false;
  } finally {
    client.close();
  }
}

export interface EnsureDaemonOptions {
  /** How long to wait for the spawned daemon to answer. */
  timeoutMs?: number;
  intervalMs?: number;
  pingTimeoutMs?: number;
}

/**
 * Ping the daemon, and when nothing answers, start it with `spawn` and wait for it to answer
 * (spec §11: the next CLI call or panel restarts a dead daemon). Real spawning is slice 2.
 */
export async function ensureDaemon(root: string, spawn: () => void | Promise<void>, options: EnsureDaemonOptions = {}): Promise<void> {
  const { socket } = projectPaths(root);
  const pingTimeoutMs = options.pingTimeoutMs ?? 500;
  if (await pingSocket(socket, pingTimeoutMs)) return;
  await spawn();
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const intervalMs = options.intervalMs ?? 100;
  for (;;) {
    if (await pingSocket(socket, pingTimeoutMs)) return;
    if (Date.now() >= deadline) throw new Error(`the bdc daemon did not answer on ${socket} within ${options.timeoutMs ?? 15_000}ms`);
    await sleep(intervalMs);
  }
}

class SocketClient implements DaemonClient {
  readonly socket: string;
  readonly #socket: net.Socket;
  readonly #pending = new Map<string, { resolve: (response: DaemonResponse) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  readonly #subscriptions: Array<{ runId: string; onView: (view: JsonValue) => void }> = [];
  readonly #closeListeners = new Set<() => void>();
  #buffer = '';
  #closed = false;

  private constructor(socket: net.Socket, socketPath: string) {
    this.#socket = socket;
    this.socket = socketPath;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.#receive(chunk));
    socket.on('error', (error: Error) => this.#fail(error));
    socket.on('close', () => this.#fail(new Error('the daemon closed the connection')));
  }

  static open(socketPath: string, timeoutMs: number): Promise<SocketClient> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(socketPath);
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`no answer from ${socketPath} within ${timeoutMs}ms`));
      }, timeoutMs);
      socket.once('error', (error: Error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeAllListeners('error');
        resolve(new SocketClient(socket, socketPath));
      });
    });
  }

  request(request: DaemonRequest, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DaemonResponse> {
    if (this.#closed) return Promise.reject(new Error('the daemon connection is closed'));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(request.id);
        reject(new Error(`the daemon did not answer ${request.type} within ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(request.id, { resolve, reject, timer });
      this.#socket.write(`${JSON.stringify(request)}\n`);
    });
  }

  async subscribe(runId: string, onView: (view: JsonValue) => void): Promise<() => void> {
    const entry = { runId, onView };
    this.#subscriptions.push(entry);
    const response = await this.request({ id: newRequestId(), type: 'subscribe', runId });
    if (!response.ok) {
      this.#forget(entry);
      throw new Error(response.error);
    }
    return () => this.#forget(entry);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => {
      this.#closeListeners.delete(listener);
    };
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#socket.destroy();
    this.#rejectPending(new Error('the daemon connection is closed'));
  }

  #forget(entry: { runId: string; onView: (view: JsonValue) => void }): void {
    const index = this.#subscriptions.indexOf(entry);
    if (index >= 0) this.#subscriptions.splice(index, 1);
  }

  #receive(chunk: string): void {
    this.#buffer += chunk;
    let newline = this.#buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== '') this.#handle(line);
      newline = this.#buffer.indexOf('\n');
    }
  }

  #handle(line: string): void {
    let message: DaemonMessage;
    try {
      message = JSON.parse(line) as DaemonMessage;
    } catch {
      return;
    }
    if (isViewMessage(message)) {
      for (const entry of this.#subscriptions) {
        if (entry.runId === message.runId) entry.onView(message.view);
      }
      return;
    }
    if (message.id === null) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    pending.resolve(message);
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    for (const listener of this.#closeListeners) listener();
    this.#closeListeners.clear();
  }

  #rejectPending(error: Error): void {
    for (const [, pending] of this.#pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isViewMessage(message: DaemonMessage): message is ViewMessage {
  return 'type' in message && message.type === 'view';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
