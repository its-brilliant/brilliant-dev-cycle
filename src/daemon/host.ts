/**
 * One run's actor, owned by the daemon (spec §5.1, §5.7). The host is generic over the machine:
 * it restores, persists after every transition, logs every event, and projects the snapshot into
 * the view the panels render (spec §7.2). The machine and the projection come from the caller.
 */
import { createActor, type Actor, type AnyStateMachine, type InspectionEvent, type Snapshot, type SnapshotFrom, type Subscription } from 'xstate';
import type { JsonValue, RunStore } from './store.js';

/** Decides whether an event may reach the machine: returns the event to send, or the reason not to. */
export type ValidateEvent = (event: unknown) => unknown | Error;

export type SendResult = { ok: true } | { ok: false; error: string };

export interface RunHostOptions {
  machine: AnyStateMachine;
  /** Written into `machine.json`; a snapshot from another version is not restored (spec §5.7). */
  machineVersion: number;
  /** The machine's input, used only when there is no snapshot to restore. */
  input: unknown;
  store: RunStore;
  /** Turns a snapshot into the UI-ready view. It must be JSON: the host stores what it returns. */
  project: (snapshot: SnapshotFrom<AnyStateMachine>) => unknown;
  /** Default: every event is accepted. The daemon passes `PersonEvent.parse` (spec §5.6). */
  validate?: ValidateEvent;
}

export class RunHost {
  readonly #machine: AnyStateMachine;
  readonly #input: unknown;
  readonly #store: RunStore;
  readonly #project: RunHostOptions['project'];
  readonly #validate: ValidateEvent | undefined;
  readonly #viewListeners = new Set<(view: JsonValue) => void>();
  #actor: Actor<AnyStateMachine> | undefined;
  #subscription: Subscription | undefined;
  #view: JsonValue | undefined;
  #stopped = false;
  #publishScheduled = false;

  constructor(options: RunHostOptions) {
    this.#machine = options.machine;
    this.#input = options.input;
    this.#store = options.store;
    this.#project = options.project;
    this.#validate = options.validate;
  }

  /** Restore from this run's snapshot when it is compatible, otherwise start the machine fresh. */
  start(): void {
    if (this.#actor) return;
    const actor = this.#createActor();
    this.#actor = actor;
    // Subscribe before start so an entry action that throws is reported as the run's error instead
    // of escaping; publish again after start to record the invoked children that only exist then.
    this.#subscription = actor.subscribe({
      next: () => this.#publish(),
      error: () => this.#publish(),
    });
    actor.start();
    this.#publish();
  }

  send(event: unknown): SendResult {
    const actor = this.#actor;
    if (!actor || this.#stopped) return { ok: false, error: 'this run is not running' };
    if (actor.getSnapshot().status === 'error') return { ok: false, error: 'this run stopped on an error' };
    const checked = this.#check(event);
    if (checked instanceof Error) return { ok: false, error: checked.message };
    this.#store.appendEvent(checked);
    try {
      actor.send(checked);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    return { ok: true };
  }

  /** Listen to views. The current view is delivered now, then every new one. Returns unsubscribe. */
  onView(listener: (view: JsonValue) => void): () => void {
    this.#viewListeners.add(listener);
    if (this.#view !== undefined) listener(this.#view);
    return () => {
      this.#viewListeners.delete(listener);
    };
  }

  get view(): JsonValue | undefined {
    return this.#view;
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#subscription?.unsubscribe();
    this.#actor?.stop();
    this.#actor = undefined;
    this.#viewListeners.clear();
  }

  #createActor(): Actor<AnyStateMachine> {
    // `subscribe` only sees the root's snapshot; a change inside a child (an agent leaving
    // `launching`) must be persisted too, so every snapshot in the system schedules a publish.
    const inspect = (event: InspectionEvent): void => {
      if (event.type === '@xstate.snapshot') this.#schedulePublish();
    };
    const stored = this.#store.readSnapshot();
    if (!stored || 'incompatible' in stored) return createActor(this.#machine, { input: this.#input, inspect });
    // machine.json is written by this class, so its `snapshot` is a persisted XState snapshot.
    // XState restores children recursively, does not re-run actions and restarts invocations.
    return createActor(this.#machine, { snapshot: stored.snapshot as Snapshot<unknown>, input: this.#input, inspect });
  }

  /** One publish per burst of snapshots (a transition updates several actors at once). */
  #schedulePublish(): void {
    if (this.#publishScheduled) return;
    this.#publishScheduled = true;
    queueMicrotask(() => {
      this.#publishScheduled = false;
      this.#publish();
    });
  }

  #publish(): void {
    const actor = this.#actor;
    if (!actor || this.#stopped) return;
    const snapshot = actor.getSnapshot();
    // Snapshot first: a crash between the two writes must never leave a view ahead of the state.
    this.#store.writeSnapshot(actor.getPersistedSnapshot());
    const view = this.#projectView(snapshot);
    // A change deep in a child (a terminal recorded) often leaves the view as it was: save the
    // state every time, but only tell listeners when what the person would see changed.
    if (this.#view !== undefined && JSON.stringify(view) === JSON.stringify(this.#view)) return;
    this.#view = view;
    this.#store.writeView(view);
    for (const listener of this.#viewListeners) listener(view);
  }

  #projectView(snapshot: SnapshotFrom<AnyStateMachine>): JsonValue {
    let view: JsonValue;
    try {
      view = toJson(this.#project(snapshot));
    } catch (error) {
      return { error: `projection failed: ${errorMessage(error)}` };
    }
    if (snapshot.status !== 'error') return view;
    return withError(view, errorMessage(snapshot.error));
  }

  #check(event: unknown): Record<string, unknown> | Error {
    if (!this.#validate) return isRecord(event) ? event : new Error('an event must be a JSON object');
    let result: unknown;
    try {
      result = this.#validate(event);
    } catch (error) {
      return toError(error);
    }
    if (result instanceof Error) return result;
    return isRecord(result) ? result : new Error('an event must be a JSON object');
  }
}

/** The view is persisted, so subscribers get exactly the JSON that is on disk. */
function toJson(raw: unknown): JsonValue {
  if (raw === undefined) return null;
  return JSON.parse(JSON.stringify(raw)) as JsonValue;
}

function withError(view: JsonValue, message: string): JsonValue {
  return isRecord(view) ? { ...view, error: message } : { view, error: message };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === 'string') return error.message;
  return String(error);
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(errorMessage(thrown));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
