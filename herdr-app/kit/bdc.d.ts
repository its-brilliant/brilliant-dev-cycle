// Types for kit/bdc.js, so the TypeScript tests and an editor can check a call.
// Kept by hand next to the module: mods are plain JavaScript Herdr loads as-is.

/** A `bdc` invocation: `[node, "/abs/dist/cli/bin.js"]`, written by `bdc herdr install`. */
export type BdcCommand = string[];

/** A person event as the mods send it (spec §5.6): `type` plus its payload. */
export interface PersonEventLike {
  type: string;
  [key: string]: unknown;
}

export interface SendResult {
  ok: boolean;
  error: string;
}

export interface StartResult extends SendResult {
  runId: string | null;
}

export interface StatusResult extends SendResult {
  view: unknown;
}

/** The host functions a kit module needs (see kit/host.js). */
export interface KitHost {
  exec(command: string, args?: string[], options?: { cwd?: string; on?: string | null; timeout?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
}

export function sendArgs(root: string, event: PersonEventLike, runId?: string | null): string[];
export function startArgs(root: string, goal: string): string[];
export function statusArgs(root: string, runId?: string | null): string[];
export function bdcCommands(host: KitHost, command: BdcCommand): {
  send(root: string, event: PersonEventLike, runId?: string | null): Promise<SendResult>;
  start(root: string, goal: string): Promise<StartResult>;
  status(root: string, runId?: string | null): Promise<StatusResult>;
};
export function send(host: KitHost, command: BdcCommand, root: string, event: PersonEventLike, runId?: string | null): Promise<SendResult>;
export function start(host: KitHost, command: BdcCommand, root: string, goal: string): Promise<StartResult>;
export function status(host: KitHost, command: BdcCommand, root: string, runId?: string | null): Promise<StatusResult>;
