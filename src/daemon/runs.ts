/**
 * The runs of one project (spec §5.1, §5.7, §7.1): creating a run, hosting its actor, and bringing
 * every unfinished run back after the daemon restarts.
 *
 * One `ProjectRuns` per project root. It owns a `RunHost` per live run and nothing else: the socket
 * server asks it for a host by run id, and the CLI asks it to create a run.
 *
 * Restore needs the machine's input, which a snapshot does not carry, so `create` writes
 * `input.json` next to `machine.json`. A run directory that exists with an input but no host (one
 * `bdc start` created in the CLI process) is adopted on first use, so the daemon picks up runs it
 * did not create itself.
 */
import { lensPrompts as readLensPrompts } from '../herd/lenses.js';
import fs from 'node:fs';
import path from 'node:path';
import { PersonEvent } from '../contracts/events.js';
import type { ProjectConfig } from '../contracts/domain.js';
import type { RunInput } from '../machines/run.js';
import { MACHINE_VERSION, wiredRunMachine, type WiredEffects } from '../runtime/wire.js';
import { projectRun, type RunSnapshot } from '../runtime/project.js';
import { RunHost } from './host.js';
import { assertRunId, projectPaths, type ProjectPaths, type RunFiles } from './paths.js';
import { RunStore, type JsonValue } from './store.js';

export interface ProjectRunsOptions {
  /** The effects a run's machine is wired with: scripted in slice 1, real in slice 2. */
  effects: (input: RunInput) => WiredEffects;
  /** Lens prompt text per lens name (§8). Slice 1 reads no prompt files, so this defaults to none. */
  lensPrompts?: Record<string, string>;
  /** When a run is done or cancelled: close everything it still has running (real runs: its hc terminals). */
  onRunEnded?: (input: RunInput) => void;
}

/** The input is stored beside the snapshot so a restart can build the same machine (§5.7). */
const INPUT_FILE = 'input.json';

export class ProjectRuns {
  readonly root: string;
  readonly #paths: ProjectPaths;
  readonly #options: ProjectRunsOptions;
  readonly #hosts = new Map<string, RunHost>();

  constructor(root: string, options: ProjectRunsOptions) {
    this.#paths = projectPaths(root);
    this.root = this.#paths.root;
    this.#options = options;
  }

  /** Starts a new run from a goal and answers its id. */
  create(goal: string, config: ProjectConfig): string {
    const runId = this.prepare(goal, config);
    const input = this.#readInput(runId);
    if (input === null) throw new Error(`run ${runId} was prepared but its input cannot be read`);
    const host = this.#host(input);
    this.#hosts.set(runId, host);
    host.start();
    return runId;
  }

  /**
   * Write a new run's input without starting it. `bdc start` uses this so the run starts in the
   * daemon only: starting it in the short-lived CLI process would launch real agents there.
   */
  prepare(goal: string, config: ProjectConfig): string {
    const runId = this.#newRunId();
    const input = this.#input(runId, goal, config);
    const files = this.#paths.run(runId);
    fs.mkdirSync(files.dir, { recursive: true });
    fs.writeFileSync(path.join(files.dir, INPUT_FILE), `${JSON.stringify(input)}\n`);
    return runId;
  }

  /** Re-creates a host for every run that has not finished, and answers the ids it restored. */
  restoreAll(): string[] {
    const restored: string[] = [];
    for (const runId of this.runs()) {
      if (this.#hosts.has(runId)) continue;
      const files = this.#paths.run(runId);
      if (isFinished(files)) continue;
      const input = this.#readInput(runId);
      if (input === null) continue;
      const host = this.#host(input);
      this.#hosts.set(runId, host);
      host.start();
      restored.push(runId);
    }
    return restored;
  }

  /** The live host for a run. A run another process created is adopted here, on first use. */
  hostFor(runId: string): RunHost | undefined {
    const live = this.#hosts.get(runId);
    if (live !== undefined) return live;
    if (!isRunId(runId)) return undefined;
    const input = this.#readInput(runId);
    if (input === null) return undefined;
    const host = this.#host(input);
    this.#hosts.set(runId, host);
    host.start();
    return host;
  }

  /** Every run in the project, live or finished, by name. */
  runs(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.#paths.runs, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((entry) => entry.isDirectory() && isRunId(entry.name))
      .map((entry) => entry.name)
      .sort();
  }

  /** Stops every host. The daemon calls this on shutdown; a CLI that created a run calls it before it exits. */
  stop(): void {
    for (const host of this.#hosts.values()) host.stop();
    this.#hosts.clear();
  }

  #host(input: RunInput): RunHost {
    const files = this.#paths.run(input.runId);
    return new RunHost({
      machine: wiredRunMachine(this.#options.effects(input)),
      machineVersion: MACHINE_VERSION,
      input,
      store: new RunStore(files, MACHINE_VERSION),
      // The host is generic; this project only ever hosts run machines.
      project: (snapshot) => projectRun(snapshot as RunSnapshot),
      onFinal: () => this.#options.onRunEnded?.(input),
      validate: (event) => {
        const parsed = PersonEvent.safeParse(event);
        if (parsed.success) return parsed.data;
        return new Error(`not a person event: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
      },
    });
  }

  #input(runId: string, goal: string, config: ProjectConfig): RunInput {
    // Lens prompts are read once, when the run is created (§8): the project's copy, else the shared
    // prompt, else the built-in default. A run keeps the prompts it started with.
    const lensPrompts = this.#options.lensPrompts ?? readLensPrompts(this.#paths.root, Object.keys(config.lenses));
    return { runId, root: this.#paths.root, goal, config, lensPrompts };
  }

  #readInput(runId: string): RunInput | null {
    const file = path.join(this.#paths.run(runId).dir, INPUT_FILE);
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return null;
    }
    try {
      return JSON.parse(text) as RunInput;
    } catch {
      return null;
    }
  }

  /** `r-` and the base36 clock, plus a suffix in the unlikely case two runs start in one millisecond. */
  #newRunId(): string {
    const base = `r-${Date.now().toString(36)}`;
    let runId = base;
    for (let suffix = 1; fs.existsSync(this.#paths.run(runId).dir); suffix += 1) runId = `${base}-${suffix}`;
    return runId;
  }
}

function isRunId(name: string): boolean {
  try {
    assertRunId(name);
    return true;
  } catch {
    return false;
  }
}

/**
 * `done` and `cancelled` are XState final states: nothing can move a run out of them, so it is not
 * restored. `failed` is not final (RETRY re-enters the stage that failed), so it is.
 */
function isFinished(files: RunFiles): boolean {
  const value = readSnapshotValue(files);
  return value === 'done' || value === 'cancelled';
}

function readSnapshotValue(files: RunFiles): string | null {
  let text: string;
  try {
    text = fs.readFileSync(files.machine, 'utf8');
  } catch {
    return null;
  }
  try {
    const record = JSON.parse(text) as { snapshot?: { value?: JsonValue } };
    const value = record.snapshot?.value;
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}
