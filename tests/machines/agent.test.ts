import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { assign, createActor, fromCallback, fromPromise, SimulatedClock, setup } from 'xstate';
import type { AnyActorRef, AnyStateMachine, InspectionEvent, Snapshot } from 'xstate';
import type {
  AgentJob,
  CloseAgentInput,
  LaunchAgentInput,
  LaunchAgentOutput,
  ObserveAgentInput,
  SendToAgentInput,
} from '../../src/contracts/actors.js';
import type { AgentObservation, AgentOutcome, AgentToParent } from '../../src/contracts/events.js';
import type { Role } from '../../src/contracts/domain.js';
import { observationsFromHcEvents } from '../../src/hc/observations.js';
import { agentMachine } from '../../src/machines/agent.js';

// ── recorded hc logs (tests/fixtures/hc-events/README.md) ──────────────────────────────────

interface Recording {
  file: string;
  terminal: string;
  role: Role;
  submit: AgentJob['submit'];
}

const recordings: Recording[] = [
  { file: 'claude-spec-done.jsonl', terminal: 't6t', role: 'specWriter', submit: 'spec' },
  { file: 'claude-planner-done.jsonl', terminal: 't6w', role: 'planner', submit: 'plan' },
  { file: 'claude-reviewer-done.jsonl', terminal: 't75', role: 'reviewer', submit: 'findings' },
  { file: 'claude-pm-killed-mid-turn.jsonl', terminal: 't79', role: 'pm', submit: 'decision' },
  { file: 'pi-builder-done.jsonl', terminal: 't72', role: 'builder', submit: 'task' },
];

const fixtureLines = (file: string): string[] =>
  readFileSync(new URL(`../fixtures/hc-events/${file}`, import.meta.url), 'utf8').split('\n');

const recordedObservations = (recording: Recording): AgentObservation[] =>
  observationsFromHcEvents(fixtureLines(recording.file), recording.terminal);

// ── observations a test feeds the machine ──────────────────────────────────────────────────

const status = (app: string, state: string): AgentObservation => ({ type: 'OBS_STATUS', app, state });
const submitted = (submission: unknown): AgentObservation => ({ type: 'OBS_SUBMITTED', submission });
const exited = (code: number | null): AgentObservation => ({ type: 'OBS_EXITED', code });
/** The agent's own app says it is working, then settles. */
const settles = (): AgentObservation[] => [status('pi', 'working'), status('pi', 'done')];

// ── harness ────────────────────────────────────────────────────────────────────────────────

const jobFor = (recording: Recording): AgentJob => ({
  key: `run-1/${recording.role}/attempt-1`,
  role: recording.role,
  agent: { cli: 'pi', model: '' },
  cwd: '/tmp/bdc-test',
  prompt: 'do the task',
  submit: recording.submit,
  timeoutMs: 500,
  keepAlive: false,
  labels: { 'bdc.run': 'run-1' },
});

const TERMINAL = 't1';

interface Options {
  /** `hold` keeps the launch promise pending so the test can snapshot inside `launching`. */
  launch?: 'resolve' | 'hold' | 'reject';
  /** `hold` keeps `sendToAgent` pending (to snapshot inside `sending`); `reject` fails the paste. */
  send?: 'hold' | 'reject';
}

interface Observer {
  input: ObserveAgentInput;
  sendBack: (event: AgentObservation) => void;
  live: boolean;
}

/** Every state path any test has been in; the reachability test reads it. */
const reached = new Set<string>();

interface StateNodeTree {
  states: Record<string, StateNodeTree>;
  on: Record<string, unknown>;
  parent?: StateNodeTree;
}

const stateTree = (node: StateNodeTree, prefix = ''): Array<{ path: string; node: StateNodeTree }> =>
  Object.entries(node.states).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [{ path, node: child }, ...stateTree(child, path)];
  });

const stateNodes = (): Array<{ path: string; node: StateNodeTree }> =>
  stateTree(agentMachine.root as unknown as StateNodeTree);

const pathsInValue = (value: unknown, prefix = ''): string[] => {
  if (typeof value === 'string') return prefix === '' ? [value] : [`${prefix}.${value}`];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`;
    return [path, ...pathsInValue(child, path)];
  });
};

interface Harness {
  parent: AnyActorRef;
  agent: AnyActorRef;
  clock: SimulatedClock;
  launches: LaunchAgentInput[];
  sent: SendToAgentInput[];
  closed: CloseAgentInput[];
  observers: Observer[];
  /** Events the agent sent its parent, in order (kept in the parent's context). */
  received: () => AgentToParent[];
  /** Feed observations as the live observer would. */
  observe: (...observations: AgentObservation[]) => void;
  /** Resolve whatever promise the test held. */
  release: () => void;
  /** Persist the parent (the agent is its invoked child), round trip it, restore it. */
  restore: () => void;
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function startAgent(job: AgentJob, options: Options = {}): Harness {
  const clock = new SimulatedClock();
  const launches: LaunchAgentInput[] = [];
  const sent: SendToAgentInput[] = [];
  const closed: CloseAgentInput[] = [];
  const observers: Observer[] = [];
  const held: Array<() => void> = [];

  const provided = agentMachine.provide({
    actors: {
      launchAgent: fromPromise<LaunchAgentOutput, LaunchAgentInput>(({ input }) => {
        launches.push(input);
        if (options.launch === 'reject') return Promise.reject(new Error('hc is not running'));
        if (options.launch === 'hold') {
          return new Promise<LaunchAgentOutput>((resolve) =>
            held.push(() => resolve({ terminal: TERMINAL, reattached: launches.length > 1 })),
          );
        }
        return Promise.resolve({ terminal: TERMINAL, reattached: launches.length > 1 });
      }),
      observeAgent: fromCallback<AgentObservation, ObserveAgentInput>(({ input, sendBack }) => {
        const observer: Observer = { input, sendBack, live: true };
        observers.push(observer);
        return () => {
          observer.live = false;
        };
      }),
      sendToAgent: fromPromise<void, SendToAgentInput>(({ input }) => {
        sent.push(input);
        if (options.send === 'reject') return Promise.reject(new Error('the terminal is gone'));
        if (options.send === 'hold') return new Promise<void>((resolve) => held.push(resolve));
        return Promise.resolve();
      }),
      closeAgent: fromPromise<void, CloseAgentInput>(({ input }) => {
        closed.push(input);
        return Promise.resolve();
      }),
    },
    delays: { emptyGrace: 50 },
  });

  const inspect = (event: InspectionEvent): void => {
    if (event.type !== '@xstate.microstep') return;
    const snapshot = event.snapshot as Snapshot<unknown> & { machine?: { id?: string }; value: unknown };
    if (snapshot.machine?.id !== 'agent') return;
    for (const path of pathsInValue(snapshot.value)) reached.add(path);
  };

  interface ParentContext {
    job: AgentJob;
    received: AgentToParent[];
  }

  const parentMachine = (logic: AnyStateMachine): AnyStateMachine =>
    setup({
      types: { context: {} as ParentContext, input: {} as AgentJob, events: {} as AgentToParent },
      actors: { agent: logic },
      actions: {
        collect: assign({ received: ({ context, event }) => [...context.received, event as AgentToParent] }),
      },
    }).createMachine({
      id: 'parent',
      context: ({ input }) => ({ job: input, received: [] }),
      invoke: { src: 'agent', id: 'agent', input: ({ context }: { context: ParentContext }) => context.job },
      initial: 'live',
      states: { live: { on: { '*': { actions: 'collect' } } } },
    });

  const harness: Harness = {
    parent: undefined as unknown as AnyActorRef,
    agent: undefined as unknown as AnyActorRef,
    clock,
    launches,
    sent,
    closed,
    observers,
    received: () => (harness.parent.getSnapshot().context as { received: AgentToParent[] }).received,
    observe: (...observations) => {
      const live = observers.filter((observer) => observer.live).at(-1);
      if (!live) throw new Error('the agent is not observing');
      for (const observation of observations) live.sendBack(observation);
    },
    release: () => {
      const newest = held.pop();
      if (!newest) throw new Error('nothing is held');
      newest();
    },
    restore: () => {
      const persisted = JSON.parse(JSON.stringify(harness.parent.getPersistedSnapshot())) as Snapshot<unknown>;
      harness.parent.stop();
      harness.parent = createActor(parentMachine(provided), { clock, snapshot: persisted, input: job, inspect });
      harness.parent.start();
      harness.agent = harness.parent.getSnapshot().children.agent as AnyActorRef;
    },
  };

  harness.parent = createActor(parentMachine(provided), { clock, input: job, inspect });
  harness.parent.start();
  harness.agent = harness.parent.getSnapshot().children.agent as AnyActorRef;
  return harness;
}

type AgentResult = Extract<AgentToParent, { type: 'AGENT_RESULT' }>;

const results = (harness: Harness): AgentResult[] =>
  harness.received().filter((event): event is AgentResult => event.type === 'AGENT_RESULT');

const outcomes = (harness: Harness): AgentOutcome[] => results(harness).map((event) => event.outcome);

// ── tests ─────────────────────────────────────────────────────────────────────────────────

describe('agentMachine', () => {
  describe('done: a result was accepted and the agent is not working (§3.3)', () => {
    it.each(recordings)('finishes $file when its submit tool accepted a result', async (recording) => {
      const harness = startAgent(jobFor(recording));
      await flush();
      const observations = recordedObservations(recording);
      const submission = { from: recording.file };

      // The submit tool answers during the last turn, so the result arrives before the agent
      // reports that it stopped working.
      harness.observe(...observations.slice(0, -1), submitted(submission), ...observations.slice(-1));
      await flush();

      expect(results(harness)).toEqual([
        { type: 'AGENT_RESULT', key: jobFor(recording).key, outcome: { status: 'done', submission } },
      ]);
      expect(harness.agent.getSnapshot().value).toBe('closed');
      expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
    });

    it.each(recordings)('does not finish $file before the submit tool accepted anything', async (recording) => {
      const harness = startAgent(jobFor(recording));
      await flush();
      harness.observe(...recordedObservations(recording));
      harness.clock.increment(400);
      await flush();

      // The last status is the agent's own `done`, so it settles: one nudge, never a result.
      expect(results(harness)).toEqual([]);
      expect(harness.sent).toEqual([{ terminal: TERMINAL, text: expect.stringContaining('bdc has no result') }]);
      expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'settled' } });
    });
  });

  it('waits for the agent to stop working before reporting the result', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();

    // The submit tool answers mid-turn: the result is kept, the job is not finished yet.
    harness.observe(status('pi', 'working'), submitted({ round: 1 }));
    await flush();
    expect(results(harness)).toEqual([]);
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });

    harness.observe(status('pi', 'done'));
    await flush();
    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'done', submission: { round: 1 } } },
    ]);
  });

  it('finishes on the submission alone when the agent already stopped working', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();
    harness.observe(status('pi', 'working'), status('pi', 'idle'));

    harness.observe(submitted({ round: 1 }));
    await flush();
    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'done', submission: { round: 1 } } },
    ]);
    expect(harness.agent.getSnapshot().value).toBe('closed');
  });

  it('ignores the startup idle that follows the bdc launch marker (the v1 pi bug)', async () => {
    const harness = startAgent(jobFor(recordings[4]!));
    await flush();
    // `bdc` is the adapter's launch marker, then pi is idle before it has done any work.
    harness.observe(status('bdc', 'working'), status('pi', 'idle'));
    harness.clock.increment(400);
    await flush();

    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });
    expect(results(harness)).toEqual([]);
    expect(harness.sent).toEqual([]);
  });

  it('nudges once, naming the submit tool, then reports empty', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();
    harness.observe(...settles());

    harness.clock.increment(50);
    await flush();
    expect(harness.sent).toEqual([{ terminal: TERMINAL, text: expect.stringContaining('report_task') }]);
    expect(results(harness)).toEqual([]);

    // The nudge did not help: a second settle without a result is empty, and the job closes.
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'settled' } });
    harness.clock.increment(50);
    await flush();
    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'empty', detail: expect.stringContaining('report_task') } },
    ]);
    expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
    expect(harness.agent.getSnapshot().value).toBe('closed');
  });

  it('reports crashed when the terminal ends before a submission', async () => {
    const recording = recordings[3]!; // killed mid-turn: no result was written
    const job = jobFor(recording);
    const lines = [
      ...fixtureLines(recording.file),
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'event',
        params: { terminal: recording.terminal, type: 'finished', data: { exit_code: null, reason: 'killed', signal: 'SIGKILL' } },
      }),
    ];
    const harness = startAgent(job);
    await flush();
    harness.observe(...observationsFromHcEvents(lines, recording.terminal));
    await flush();

    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'crashed', detail: expect.stringContaining('ended') } },
    ]);
    expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
  });

  it('reports the exit code of a terminal that ended without a result', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();
    harness.observe(status('pi', 'working'), exited(1));
    await flush();

    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'crashed', detail: expect.stringContaining('code 1') } },
    ]);
    expect(harness.agent.getSnapshot().value).toBe('closed');
  });

  it('still reports the result when the terminal ends after the submit tool accepted it', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();
    harness.observe(status('pi', 'working'), submitted({ round: 1 }), exited(0));
    await flush();

    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'done', submission: { round: 1 } } },
    ]);
    expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
  });

  it('reports empty when the nudge cannot be sent at all', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job, { send: 'reject' });
    await flush();
    harness.observe(...settles());
    harness.clock.increment(50);
    await flush();

    expect(harness.sent).toHaveLength(1);
    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'empty', detail: expect.stringContaining('report_task') } },
    ]);
    expect(harness.agent.getSnapshot().value).toBe('closed');
  });

  it('keeps the job running when a follow-up cannot be pasted', async () => {
    const job = { ...jobFor(recordings[4]!), keepAlive: true };
    const harness = startAgent(job, { send: 'reject' });
    await flush();
    harness.observe(status('pi', 'working'), submitted({ round: 1 }), status('pi', 'done'));
    await flush();

    harness.agent.send({ type: 'FOLLOW_UP', prompt: 'fix it' });
    await flush();
    expect(harness.sent).toEqual([{ terminal: TERMINAL, text: 'fix it' }]);
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });
    expect(results(harness)).toHaveLength(1);
  });

  it('reports timedOut when the role timeout passes while running', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();
    harness.observe(status('pi', 'working'));

    harness.clock.increment(job.timeoutMs);
    await flush();
    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'timedOut', detail: expect.stringContaining(String(job.timeoutMs)) } },
    ]);
    expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
  });

  it('pauses the role timeout while the agent is inside ask_user', async () => {
    const job = jobFor(recordings[3]!);
    const harness = startAgent(job);
    await flush();
    const questions = [
      { id: 'q1', title: 'Which?', body: '', kind: 'single' as const, options: [], allowOther: true },
    ];
    harness.observe({ type: 'OBS_ASKING', askId: 'ask-1', questions });

    expect(harness.agent.getSnapshot().value).toEqual({ running: 'askingYou' });
    expect(harness.received()).toEqual([{ type: 'AGENT_ASKING', key: job.key, askId: 'ask-1', questions }]);

    harness.clock.increment(job.timeoutMs * 3);
    await flush();
    expect(results(harness)).toEqual([]);
    expect(harness.agent.getSnapshot().value).toEqual({ running: 'askingYou' });

    harness.observe({ type: 'OBS_ASK_DONE', askId: 'ask-1' });
    expect(harness.received().at(-1)).toEqual({ type: 'AGENT_ASK_DONE', key: job.key, askId: 'ask-1' });
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });

    // The clock runs again once the answer is in.
    harness.clock.increment(job.timeoutMs);
    await flush();
    expect(outcomes(harness).map((outcome) => outcome.status)).toEqual(['timedOut']);
  });

  it('sends the keys the person chose when the agent waits on a prompt', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job);
    await flush();
    harness.observe({ type: 'OBS_PROMPT', prompt: 'Trust this folder?', choices: ['Trust', "Don't"] });

    expect(harness.agent.getSnapshot().value).toEqual({ running: 'needsYou' });
    expect(harness.received()).toEqual([
      { type: 'AGENT_NEEDS_YOU', key: job.key, prompt: 'Trust this folder?', choices: ['Trust', "Don't"] },
    ]);

    harness.agent.send({ type: 'PROMPT_CHOICE', choice: 'Trust' });
    await flush();
    expect(harness.sent).toEqual([{ terminal: TERMINAL, keys: ['Trust'] }]);
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });
  });

  it('goes back to running when the prompt clears without a choice', async () => {
    const harness = startAgent(jobFor(recordings[4]!));
    await flush();
    harness.observe({ type: 'OBS_PROMPT', prompt: 'Trust this folder?', choices: ['Trust'] });
    harness.observe({ type: 'OBS_PROMPT_CLEARED' });
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });
    expect(harness.sent).toEqual([]);
  });

  it('reports failed with the message when the terminal cannot be launched', async () => {
    const job = jobFor(recordings[4]!);
    const harness = startAgent(job, { launch: 'reject' });
    await flush();

    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'failed', detail: expect.stringContaining('hc is not running') } },
    ]);
    expect(harness.closed).toEqual([{ terminal: '' }]);
    expect(harness.agent.getSnapshot().value).toBe('closed');
  });

  it('keeps a keepAlive session alive and reports every follow-up result', async () => {
    const job = { ...jobFor(recordings[4]!), keepAlive: true };
    const harness = startAgent(job);
    await flush();
    harness.observe(status('pi', 'working'), submitted({ round: 1 }), status('pi', 'done'));
    await flush();

    expect(results(harness)).toEqual([
      { type: 'AGENT_RESULT', key: job.key, outcome: { status: 'done', submission: { round: 1 } } },
    ]);
    expect(harness.agent.getSnapshot().value).toBe('done');
    expect(harness.closed).toEqual([]);

    harness.agent.send({ type: 'FOLLOW_UP', prompt: 'fix the failing check' });
    await flush();
    expect(harness.sent).toEqual([{ terminal: TERMINAL, text: 'fix the failing check' }]);
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });

    // The previous submission is gone: settling now is not a new result.
    harness.observe(status('pi', 'idle'));
    await flush();
    expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'settled' } });
    expect(results(harness)).toHaveLength(1);

    harness.observe(status('pi', 'working'), submitted({ round: 2 }), status('pi', 'done'));
    await flush();
    expect(outcomes(harness)).toEqual([
      { status: 'done', submission: { round: 1 } },
      { status: 'done', submission: { round: 2 } },
    ]);

    harness.agent.send({ type: 'CLOSE' });
    await flush();
    expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
    expect(harness.agent.getSnapshot().value).toBe('closed');
  });

  it('keeps a context that survives a JSON round trip (it is persisted, §5.7)', async () => {
    const job = { ...jobFor(recordings[4]!), keepAlive: true };
    const harness = startAgent(job, { send: 'hold' });
    await flush();
    harness.observe(status('pi', 'working'), submitted({ round: 1 }), status('pi', 'done'));
    await flush();
    harness.agent.send({ type: 'FOLLOW_UP', prompt: 'fix it' });
    await flush();

    const context = harness.agent.getSnapshot().context as unknown as Record<string, unknown>;
    expect(JSON.parse(JSON.stringify(context))).toEqual(context);
    expect(context.pendingSend).toEqual({ terminal: TERMINAL, text: 'fix it' });
    expect(context.agentState).toBe('done');
  });

  describe('CLOSE', () => {
    interface CloseCase {
      state: string;
      options?: Options;
      /** The terminal `closeAgent` gets; there is none yet while launching. */
      terminal?: string;
      /** Bring the agent into `state` before CLOSE. */
      reach?: (harness: Harness) => Promise<void>;
    }

    const cases: CloseCase[] = [
      { state: 'launching', options: { launch: 'hold' }, terminal: '' },
      { state: 'running.active.working' },
      {
        state: 'running.active.settled',
        reach: async (harness) => harness.observe(...settles()),
      },
      {
        state: 'running.askingYou',
        reach: async (harness) =>
          harness.observe({
            type: 'OBS_ASKING',
            askId: 'ask-1',
            questions: [{ id: 'q1', title: 'Which?', body: '', kind: 'confirm', options: [], allowOther: false }],
          }),
      },
      {
        state: 'running.needsYou',
        reach: async (harness) => harness.observe({ type: 'OBS_PROMPT', prompt: 'Trust this folder?', choices: ['Trust'] }),
      },
      {
        state: 'running.sending',
        options: { send: 'hold' },
        reach: async (harness) => {
          harness.observe(status('pi', 'working'), submitted({ round: 1 }), status('pi', 'done'));
          harness.agent.send({ type: 'FOLLOW_UP', prompt: 'again' });
        },
      },
      {
        state: 'done',
        reach: async (harness) => harness.observe(status('pi', 'working'), submitted({ round: 1 }), status('pi', 'done')),
      },
      {
        state: 'empty',
        options: { send: 'hold' },
        reach: async (harness) => {
          harness.observe(...settles());
          harness.clock.increment(50);
        },
      },
    ];

    it.each(cases)('closes the terminal once from $state', async ({ state, options, terminal = TERMINAL, reach }) => {
      const job = { ...jobFor(recordings[4]!), keepAlive: true };
      const harness = startAgent(job, options);
      await flush();
      if (reach) {
        await reach(harness);
        await flush();
      }
      expect(harness.agent.getSnapshot().value).toEqual(pathValue(state));

      harness.agent.send({ type: 'CLOSE' });
      await flush();
      expect(harness.closed).toEqual([{ terminal }]);
      expect(harness.agent.getSnapshot().value).toBe('closed');

      // A second CLOSE has nothing left to do: `closeAgent` is not called twice.
      harness.agent.send({ type: 'CLOSE' });
      await flush();
      expect(harness.closed).toEqual([{ terminal }]);
    });
  });

  describe('restore (§5.7)', () => {
    it('re-attaches to the terminal and never reports the result twice', async () => {
      const recording = recordings[4]!;
      const job = jobFor(recording);
      const harness = startAgent(job);
      await flush();
      const observations = recordedObservations(recording);
      harness.observe(...observations.slice(0, -1));
      const terminalBefore = harness.observers.at(-1)!.input.terminal;

      harness.restore();
      await flush();

      // XState restores a promise that already settled instead of restarting it, so `launchAgent`
      // does not run again here and cannot start a second agent. The re-attach is the callback
      // observer, which restarts on the terminal the restored context kept (§3.2, §5.7); the
      // `launching` case below is where `launchAgent` itself runs again.
      expect(harness.launches).toHaveLength(1);
      expect(harness.observers.at(-1)!.input).toEqual({ job, terminal: terminalBefore });
      expect(results(harness)).toEqual([]);

      harness.observe(submitted({ from: recording.file }), ...observations.slice(-1));
      await flush();
      expect(results(harness)).toHaveLength(1);
      expect(results(harness)[0]).toEqual({
        type: 'AGENT_RESULT',
        key: job.key,
        outcome: { status: 'done', submission: { from: recording.file } },
      });
      expect(harness.closed).toEqual([{ terminal: TERMINAL }]);
    });

    it('restores a keepAlive session idle in done without reporting again', async () => {
      const job = { ...jobFor(recordings[4]!), keepAlive: true };
      const harness = startAgent(job);
      await flush();
      harness.observe(status('pi', 'working'), submitted({ round: 1 }), status('pi', 'done'));
      await flush();
      expect(results(harness)).toHaveLength(1);

      harness.restore();
      await flush();
      expect(harness.agent.getSnapshot().value).toBe('done');
      expect(results(harness)).toHaveLength(1);

      harness.agent.send({ type: 'FOLLOW_UP', prompt: 'fix it' });
      await flush();
      expect(harness.sent).toEqual([{ terminal: TERMINAL, text: 'fix it' }]);
      harness.observe(status('pi', 'working'), submitted({ round: 2 }), status('pi', 'done'));
      await flush();
      expect(outcomes(harness).map((outcome) => outcome.status)).toEqual(['done', 'done']);
    });

    it('launches again, as a re-attach, when the snapshot is still launching', async () => {
      const job = jobFor(recordings[4]!);
      const harness = startAgent(job, { launch: 'hold' });
      await flush();
      expect(harness.agent.getSnapshot().value).toBe('launching');

      harness.restore();
      await flush();

      // A pending launch promise is re-run on restore: the same job key, so `launchAgent`
      // re-attaches instead of starting a second agent (§3.2).
      expect(harness.launches).toEqual([{ job }, { job }]);
      harness.release();
      await flush();
      expect(harness.agent.getSnapshot().value).toEqual({ running: { active: 'working' } });
      expect(harness.observers.at(-1)!.input.terminal).toBe(TERMINAL);
      expect(results(harness)).toEqual([]);
    });
  });

  it('reaches every state', () => {
    const missing = stateNodes()
      .map(({ path }) => path)
      .filter((path) => !reached.has(path));
    expect(missing).toEqual([]);
  });

  it('acts on, or deliberately drops, every event in every state', () => {
    const handled = (node: StateNodeTree): string[] => {
      const names = new Set<string>();
      for (let current: StateNodeTree | undefined = node; current; current = current.parent) {
        // `xstate.done.actor.*` / `xstate.error.actor.*` belong to `onDone`/`onError`, not here.
        for (const name of Object.keys(current.on)) if (!name.startsWith('xstate.')) names.add(name);
      }
      return [...names].sort();
    };

    // What each state reacts to: its own `on` plus its ancestors'. Every other event it drops on
    // purpose, so a transition that stops (or starts) handling an event has to change this table.
    const expected: Record<string, string[]> = {
      launching: ['CLOSE'],
      running: ['CLOSE', 'OBS_EXITED'],
      'running.active': ['CLOSE', 'OBS_ASKING', 'OBS_EXITED', 'OBS_PROMPT', 'OBS_STATUS', 'OBS_SUBMITTED'],
      'running.active.working': ['CLOSE', 'OBS_ASKING', 'OBS_EXITED', 'OBS_PROMPT', 'OBS_STATUS', 'OBS_SUBMITTED'],
      'running.active.settled': ['CLOSE', 'OBS_ASKING', 'OBS_EXITED', 'OBS_PROMPT', 'OBS_STATUS', 'OBS_SUBMITTED'],
      'running.sending': ['CLOSE', 'OBS_EXITED'],
      'running.askingYou': ['CLOSE', 'OBS_ASK_DONE', 'OBS_EXITED'],
      'running.needsYou': ['CLOSE', 'OBS_EXITED', 'OBS_PROMPT_CLEARED', 'PROMPT_CHOICE'],
      done: ['CLOSE', 'FOLLOW_UP'],
      empty: ['CLOSE'],
      crashed: [],
      timedOut: [],
      failed: [],
      closing: [],
      closed: [],
    };

    const nodes = stateNodes();
    expect(nodes.map(({ path }) => path).sort()).toEqual(Object.keys(expected).sort());
    expect(nodes.map(({ path, node }) => ({ path, acts: handled(node) }))).toEqual(
      nodes.map(({ path }) => ({ path, acts: expected[path] })),
    );
  });
});

/** `running.active.working` → the state value shape XState reports. */
function pathValue(path: string): unknown {
  const parts = path.split('.');
  let value: unknown = parts.pop();
  for (const part of parts.reverse()) value = { [part]: value };
  return value;
}
