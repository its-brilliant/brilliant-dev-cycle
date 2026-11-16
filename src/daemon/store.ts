/**
 * One run's files on disk (spec §5.7, §10): the persisted snapshot, the append-only event log and
 * the UI projection. The daemon is the single writer; readers only read whole files, which is why
 * every write goes through a temp file and a rename.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { RunFiles } from './paths.js';

/** Anything bdc writes as JSON. Views and snapshots are stored without being interpreted. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** What `machine.json` holds. The version is what lets an upgrade refuse an old snapshot. */
export interface RunSnapshotRecord {
  machineVersion: number;
  snapshot: unknown;
}

/** `readSnapshot` answers with the record, `{ incompatible: true }` for another machine version, or null. */
export type StoredSnapshot = RunSnapshotRecord | { incompatible: true };

/** One line of `events.jsonl`: the event as sent, plus when the daemon accepted it. */
export type LoggedEvent = { at: string } & Record<string, unknown>;

export class RunStore {
  readonly files: RunFiles;
  readonly machineVersion: number;

  constructor(files: RunFiles, machineVersion: number) {
    this.files = files;
    this.machineVersion = machineVersion;
  }

  writeSnapshot(snapshot: unknown): void {
    writeAtomic(this.files.machine, JSON.stringify({ machineVersion: this.machineVersion, snapshot }));
  }

  readSnapshot(): StoredSnapshot | null {
    const record = readJson(this.files.machine);
    if (!isRecord(record) || !('snapshot' in record)) return null;
    if (record.machineVersion !== this.machineVersion) return { incompatible: true };
    return { machineVersion: this.machineVersion, snapshot: record.snapshot };
  }

  /** Append one event. The line goes out in a single write, so a reader never sees half of it. */
  appendEvent(event: Record<string, unknown>): LoggedEvent {
    const logged: LoggedEvent = { ...event, at: new Date().toISOString() };
    fs.mkdirSync(this.files.dir, { recursive: true });
    fs.appendFileSync(this.files.events, `${JSON.stringify(logged)}\n`);
    return logged;
  }

  /** Every event, in order. A line torn by a crash is skipped rather than losing the whole log. */
  readEvents(): LoggedEvent[] {
    let text: string;
    try {
      text = fs.readFileSync(this.files.events, 'utf8');
    } catch {
      return [];
    }
    const events: LoggedEvent[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const parsed = parseJson(line);
      if (isRecord(parsed) && typeof parsed.at === 'string') events.push(parsed as LoggedEvent);
    }
    return events;
  }

  writeView(view: JsonValue): void {
    writeAtomic(this.files.view, JSON.stringify(view));
  }

  /** The projection as last written, or undefined when this run has none yet. */
  readView(): JsonValue | undefined {
    return readJson(this.files.view);
  }
}

let tempCounter = 0;

/** Write next to the target, then rename: a reader sees the old file or the new one, never a mix. */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${(tempCounter += 1)}.tmp`;
  try {
    fs.writeFileSync(temp, text);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

function readJson(file: string): JsonValue | undefined {
  try {
    return parseJson(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** `undefined` means "not JSON" (missing file, torn write); JSON `null` stays a value. */
function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
