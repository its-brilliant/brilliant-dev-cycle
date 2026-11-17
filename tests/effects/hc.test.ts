import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assign, createActor, setup } from 'xstate';
import type { AnyActorRef, InspectionEvent, PromiseActorLogic, Snapshot } from 'xstate';
import type { AgentJob, LaunchAgentOutput, ObserveAgentInput } from '../../src/contracts/actors.js';
import type { AgentObservation, AgentToParent, AgentOutcome } from '../../src/contracts/events.js';
import { agentDir, deliveredFile, inboxFile } from '../../src/contracts/inbox.js';
import { ask, asksFile, reportedFile } from '../../src/agents/asks.js';
import { BDC_ADAPT, hcEffects } from '../../src/effects/hc.js';
import type { AgentCommand, HcEffects } from '../../src/effects/hc.js';
import { agentMachine } from '../../src/machines/agent.js';

// ── the fake hc ────────────────────────────────────────────────────────────────────────────
// The suite must never reach the person's hc or Herdr app (spec §12): every test points hcBin at
// this script, which records its argv and answers from files the test writes.

const fakeHcScript = (dir: string, address: string): string => `#!/usr/bin/env node
import fs from 'node:fs';
const dir = ${JSON.stringify(dir)};
const address = ${JSON.stringify(address)};
const argv = process.argv.slice(2);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify(argv) + '\\n');
const file = (name) => {
  try {
    return fs.readFileSync(dir + '/' + name, 'utf8');
  } catch {
    return null;
  }
};
const command = argv[0];
const failing = file('fail');
if (failing !== null && failing.trim() === command) {
  process.stderr.write('hc ' + command + ' is broken\\n');
  process.exit(2);
}
switch (command) {
  case 'run':
    process.stdout.write(JSON.stringify({ address }) + '\\n');
    break;
  case 'ls':
    process.stdout.write(file('ls.json') ?? '{"terminals":[]}\\n');
    break;
  case 'events':
    process.stdout.write(file('events.jsonl') ?? '');
    if (file('events-end') !== null) process.exit(0);
    setInterval(() => {}, 250);
    process.on('SIGTERM', () => process.exit(0));
    process.on('SIGINT', () => process.exit(0));
    break;
  case 'read':
    process.stdout.write(file('screen.txt') ?? '');
    break;
  case 'get':
    process.stdout.write(file('get.json') ?? '{"exit_code":0,"state":"finished"}\\n');
    break;
  case 'send':
  case 'keys':
  case 'kill':
  case 'rm':
    break;
  default:
    process.stderr.write('unknown hc command: ' + command + '\\n');
    process.exit(2);
}
`;

interface FakeHc {
  bin: string;
  /** Every argv the fake was called with, in order. */
  calls(): string[][];
  callsOf(command: string): string[][];
  /** The lines `hc events` prints before it waits to be killed. */
  events(lines: string[]): void;
  /** `hc events` prints its lines and exits instead of waiting. */
  endEvents(): void;
  /** What `hc read` prints. */
  screen(text: string): void;
  /** What `hc ls --label ...` answers. */
  terminals(terminals: Array<{ address: string; state?: string }>): void;
  /** What `hc get --json` answers. */
  get(value: { exit_code: number | null; state: string }): void;
  /** Make one hc command exit 2 with a message on stderr. */
  fail(command: string): void;
}

function fakeHc(options: { dir: string; address?: string }): FakeHc {
  const bin = path.join(options.dir, 'hc.mjs');
  fs.writeFileSync(bin, fakeHcScript(options.dir, options.address ?? 't1'), { mode: 0o755 });
  const write = (name: string, text: string): void => fs.writeFileSync(path.join(options.dir, name), text);
  const calls = (): string[][] => {
    let log: string;
    try {
      log = fs.readFileSync(path.join(options.dir, 'calls.jsonl'), 'utf8');
    } catch {
      return [];
    }
    return log
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as string[]);
  };
  return {
    bin,
    calls,
    callsOf: (command) => calls().filter((argv) => argv[0] === command),
    events: (lines) => write('events.jsonl', `${lines.join('\n')}\n`),
    endEvents: () => write('events-end', ''),
    screen: (text) => write('screen.txt', text),
    terminals: (terminals) => write('ls.json', `${JSON.stringify({ terminals })}\n`),
    get: (value) => write('get.json', `${JSON.stringify(value)}\n`),
    fail: (command) => write('fail', command),
  };
}

// ── fixtures and temp dirs ────────────────────────────────────────────────────────────────

const fixtureLines = (file: string): string[] =>
  fs.readFileSync(new URL(`../fixtures/hc-events/${file}`, import.meta.url), 'utf8').split('\n');

const screen = (name: string): string => fs.readFileSync(new URL(`../fixtures/screens/${name}`, import.meta.url), 'utf8');

const statusLine = (terminal: string, app: string, state: string): string =>
  JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { terminal, type: 'status', data: { status: { app, state } } } });

/** The launch marker, then the agent's own first turn. No end of turn: the test decides that. */
const workingEvents = (terminal: string): string[] => [statusLine(terminal, 'bdc', 'working'), statusLine(terminal, 'pi', 'working')];

const tempDirs: string[] = [];
const harnesses: Harness[] = [];
const stopped: Array<() => void> = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-hc-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const stop of stopped.splice(0)) stop();
  for (const harness of harnesses.splice(0)) harness.stop();
  for (const dir of tempDirs.splice(0)) {
    try {
      // A fake hc child may still be exiting and writing its log; the temp dir can wait.
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, check: () => T | null | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await wait(10);
  }
}

// ── one job, one agent machine ────────────────────────────────────────────────────────────

const RUN_ID = 'run-1';
const TERMINAL = 't72';

const job = (): AgentJob => ({
  key: 'run-1/builder/p1-t1/attempt-1',
  role: 'builder',
  agent: { cli: 'pi', model: '' },
  cwd: '/tmp/acme-api/.worktrees/p1-t1',
  prompt: 'Create hello.sh and commit it',
  submit: 'task',
  timeoutMs: 60_000,
  keepAlive: false,
  labels: { 'bdc.run': RUN_ID, 'bdc.role': 'builder', 'bdc.phase': 'p1' },
});

/** The per-CLI command line another module supplies; hc only wraps it. */
const commandFor = (input: AgentJob): AgentCommand => ({
  argv: ['pi', '--model', input.agent.model, input.prompt],
  env: { ANTHROPIC_API_KEY: 'test-key' },
});

function writeInbox(root: string, entry: { seq: number; kind: string; submission: unknown }): void {
  const dir = agentDir(root, RUN_ID, job().key);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(inboxFile(dir), `${JSON.stringify({ at: '2026-11-17T09:00:00.000Z', ...entry })}\n`);
}

interface Harness {
  parent: AnyActorRef;
  agent: AnyActorRef;
  received(): AgentToParent[];
  /** How many OBS_SUBMITTED the agent actor got: a restored observer must not add to this. */
  delivered(): number;
  restore(): void;
  stop(): void;
}

interface ParentContext {
  job: AgentJob;
  received: AgentToParent[];
}

function startAgent(effects: HcEffects, input: AgentJob): Harness {
  let submissions = 0;
  const inspect = (event: InspectionEvent): void => {
    if (event.type !== '@xstate.event') return;
    if ((event.event as { type?: unknown }).type === 'OBS_SUBMITTED') submissions += 1;
  };

  const provided = agentMachine.provide({ actors: effects });
  const parentMachine = setup({
    types: { context: {} as ParentContext, input: {} as AgentJob, events: {} as AgentToParent },
    actors: { agent: provided },
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
    received: () => (harness.parent.getSnapshot().context as ParentContext).received,
    delivered: () => submissions,
    restore: () => {
      const persisted = JSON.parse(JSON.stringify(harness.parent.getPersistedSnapshot())) as Snapshot<unknown>;
      harness.parent.stop();
      harness.parent = createActor(parentMachine, { snapshot: persisted, input, inspect });
      harness.parent.start();
      harness.agent = harness.parent.getSnapshot().children.agent as AnyActorRef;
    },
    stop: () => {
      harness.parent.stop();
    },
  };
  harness.parent = createActor(parentMachine, { input, inspect });
  harness.parent.start();
  harness.agent = harness.parent.getSnapshot().children.agent as AnyActorRef;
  harnesses.push(harness);
  return harness;
}

const outcomes = (harness: Harness): AgentOutcome[] =>
  harness
    .received()
    .filter((event): event is Extract<AgentToParent, { type: 'AGENT_RESULT' }> => event.type === 'AGENT_RESULT')
    .map((event) => event.outcome);

const needsYou = (harness: Harness): Array<Extract<AgentToParent, { type: 'AGENT_NEEDS_YOU' }>> =>
  harness.received().filter((event): event is Extract<AgentToParent, { type: 'AGENT_NEEDS_YOU' }> => event.type === 'AGENT_NEEDS_YOU');

/**
 * Run one promise actor to its end. The error handler matters: a rejection from an actor nobody
 * invoked has no parent to report it to, and XState would rethrow it as an unhandled error.
 */
async function settled<TInput, TOutput>(logic: PromiseActorLogic<TOutput, TInput>, input: TInput) {
  const actor = createActor(logic, { input });
  actor.subscribe({ error: () => undefined });
  actor.start();
  return until('the actor to settle', () => {
    const snapshot = actor.getSnapshot();
    return snapshot.status === 'active' ? undefined : snapshot;
  });
}

async function launch(effects: HcEffects, input: AgentJob): Promise<LaunchAgentOutput> {
  const snapshot = await settled(effects.launchAgent, { job: input });
  if (snapshot.status !== 'done') throw new Error(`the launch failed: ${String(snapshot.error)}`);
  return snapshot.output;
}

/**
 * The observer on its own, collecting every observation it reports. A restart is a new instance on
 * the same terminal, which is what a restored daemon does (§5.7).
 */
function observing(effects: HcEffects, input: AgentJob, terminal: string): { events: AgentObservation[]; restart: () => void } {
  const events: AgentObservation[] = [];
  const parent = setup({
    types: { context: {} as ObserveAgentInput, input: {} as ObserveAgentInput, events: {} as AgentObservation },
    actors: { observe: effects.observeAgent },
    actions: {
      collect: ({ event }) => {
        events.push(event as AgentObservation);
      },
    },
  }).createMachine({
    id: 'observer-parent',
    context: ({ input: machineInput }) => machineInput,
    invoke: { src: 'observe', input: ({ context }: { context: ObserveAgentInput }) => context },
    on: { '*': { actions: 'collect' } },
  });
  const start = (): AnyActorRef => {
    const actor = createActor(parent, { input: { job: input, terminal } });
    actor.start();
    stopped.push(() => actor.stop());
    return actor;
  };
  start();
  return {
    events,
    restart: () => {
      start();
    },
  };
}

/** Every ask the observer reported. */
const asks = (observer: { events: AgentObservation[] }): Array<Extract<AgentObservation, { type: 'OBS_ASKING' }>> =>
  observer.events.filter((event): event is Extract<AgentObservation, { type: 'OBS_ASKING' }> => event.type === 'OBS_ASKING');

// ── tests ─────────────────────────────────────────────────────────────────────────────────

describe('hcEffects.launchAgent', () => {
  it('launches the CLI through bdc-adapt in a hidden terminal, with the labels and the agent env', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    const input = job();
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    expect(await launch(effects, input)).toEqual({ terminal: TERMINAL, reattached: false });

    // §3.2: no `where` label, `--no-parent --no-notify`, so the person never sees the terminal.
    expect(fake.callsOf('run')).toEqual([
      [
        'run',
        '--bg',
        '--json',
        '--no-parent',
        '--no-notify',
        '--cwd',
        input.cwd,
        '--label',
        'bdc.run=run-1',
        '--label',
        'bdc.role=builder',
        '--label',
        'bdc.phase=p1',
        '--label',
        `bdc.key=${input.key}`,
        '--',
        'env',
        'ANTHROPIC_API_KEY=test-key',
        'BDC_ROOT=' + root,
        'BDC_RUN=run-1',
        `BDC_KEY=${input.key}`,
        'BDC_ROLE=builder',
        'BDC_SUBMIT=task',
        BDC_ADAPT,
        'pi',
        '--model',
        '',
        input.prompt,
      ],
    ]);
    // The job's directory holds its inbox before the agent can call its submit tool.
    expect(fs.statSync(agentDir(root, RUN_ID, input.key)).isDirectory()).toBe(true);
  });

  it('re-attaches to a live terminal with the same key instead of starting a second agent', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir });
    fake.terminals([{ address: 't9', state: 'live' }]);
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    expect(await launch(effects, job())).toEqual({ terminal: 't9', reattached: true });
    expect(fake.callsOf('run')).toEqual([]);
  });

  it('fails with a message a person can act on when hc cannot be started', async () => {
    const dir = tempDir();
    const effects = hcEffects({
      hcBin: path.join(dir, 'no-such-hc'),
      commandFor,
      pollMs: 10,
      root: path.join(dir, 'acme-api'),
      runId: RUN_ID,
    });

    await expect(launch(effects, job())).rejects.toThrow(/hc is not installed or not runnable/);
  });

  it('reports a failed launch to the machine, which fails the job with that message', async () => {
    const dir = tempDir();
    const fake = fakeHc({ dir });
    fake.fail('ls');
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root: path.join(dir, 'acme-api'), runId: RUN_ID });

    const harness = startAgent(effects, job());
    const outcome = await until('the failed result', () => outcomes(harness)[0]);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.detail : '').toContain('hc ls failed');
    expect(outcome.status === 'failed' ? outcome.detail : '').toContain('hc ls is broken');
  });

  it('fails the job, with a detail a person can act on, when hc is not installed', async () => {
    const dir = tempDir();
    const effects = hcEffects({
      hcBin: path.join(dir, 'no-such-hc'),
      commandFor,
      pollMs: 10,
      root: path.join(dir, 'acme-api'),
      runId: RUN_ID,
    });

    const harness = startAgent(effects, job());
    const outcome = await until('the failed result', () => outcomes(harness)[0]);

    expect(outcome.status).toBe('failed');
    expect(outcome.status === 'failed' ? outcome.detail : '').toContain('hc is not installed or not runnable');
  });
});

describe('hcEffects.observeAgent', () => {
  it('reports the submission the agent wrote to its inbox, and the job finishes done', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(fixtureLines('pi-builder-done.jsonl'));
    fake.screen(screen('ordinary-working.txt'));
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const harness = startAgent(effects, job());
    await until('the observer to follow the terminal', () => fake.callsOf('events').length > 0);
    writeInbox(root, { seq: 1, kind: 'task', submission: { summary: 'created hello.sh', notes: [] } });

    expect(await until('the result', () => outcomes(harness)[0])).toEqual({
      status: 'done',
      submission: { summary: 'created hello.sh', notes: [] },
    });
    expect(fake.callsOf('events')[0]).toEqual(['events', '--json', '--label', `bdc.key=${job().key}`]);
    expect(await until('the close', () => fake.callsOf('rm')[0])).toEqual(['rm', TERMINAL]);
  });

  it('delivers a submission that was already in the inbox when it started', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.screen(screen('ordinary-working.txt'));
    // The agent submitted while the daemon was down: nothing may be lost on the way back up (§5.7).
    writeInbox(root, { seq: 1, kind: 'task', submission: { summary: 'committed before the restart' } });
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const harness = startAgent(effects, job());

    expect(await until('the result', () => outcomes(harness)[0])).toEqual({
      status: 'done',
      submission: { summary: 'committed before the restart' },
    });
  });

  it('does not deliver an inbox entry twice when the observer is restored (§5.7)', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.screen(screen('ordinary-working.txt'));
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const harness = startAgent(effects, job());
    await until('the observer to read the screen', () => fake.callsOf('read').length > 0);
    writeInbox(root, { seq: 1, kind: 'task', submission: { summary: 'first turn' } });

    // The delivery is on disk: `delivered` carries the highest seq already handed to the machine.
    const delivered = deliveredFile(agentDir(root, RUN_ID, job().key));
    await until('the delivery', () => fs.existsSync(delivered) && fs.readFileSync(delivered, 'utf8').trim() === '1');
    expect(harness.delivered()).toBe(1);

    harness.restore();
    await wait(200);

    // The restarted observer re-reads `delivered`, so the restored machine is not told again.
    expect(harness.delivered()).toBe(1);
    expect(fake.callsOf('events')).toHaveLength(2);
  });

  it('reports the exit code when the event stream ends and the terminal is finished', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.endEvents();
    fake.get({ exit_code: 3, state: 'finished' });
    fake.screen(screen('ordinary-working.txt'));
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const harness = startAgent(effects, job());
    const outcome = await until('the crashed result', () => outcomes(harness)[0]);

    expect(outcome.status).toBe('crashed');
    expect(outcome.status === 'crashed' ? outcome.detail : '').toContain('code 3');
  });

  it('turns a trust prompt on screen into a choice the person makes in PM chat, and presses its keys', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.screen(screen('claude-trust.txt'));
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const harness = startAgent(effects, job());
    const card = await until('the prompt card', () => needsYou(harness)[0]);
    expect(card).toEqual({
      type: 'AGENT_NEEDS_YOU',
      key: job().key,
      prompt: 'Do you trust the files in this folder?',
      choices: ['Trust this folder', "Don't trust it"],
    });

    harness.agent.send({ type: 'PROMPT_CHOICE', choice: "Don't trust it" });
    expect(await until('the keys', () => fake.callsOf('keys')[0])).toEqual(['keys', TERMINAL, 'down', 'enter']);
  });

  it('says the prompt went away when the agent is working again', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.screen(screen('claude-trust.txt'));
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const harness = startAgent(effects, job());
    await until('the prompt card', () => needsYou(harness)[0]);
    fake.screen(screen('ordinary-working.txt'));

    await until('the prompt to clear', () =>
      harness.agent.getSnapshot().value !== null &&
      JSON.stringify(harness.agent.getSnapshot().value) === JSON.stringify({ running: { active: 'working' } }),
    );
    expect(needsYou(harness)).toHaveLength(1);
  });
});

describe('hcEffects.observeAgent and the question tool', () => {
  const questions = [
    { id: 'q-scope', title: 'How far should this go?', body: '', kind: 'single' as const, options: [{ id: 'small', label: 'Small' }], recommended: 'small', allowOther: true },
  ];

  it('reports an ask_user call as OBS_ASKING, and a restarted observer does not report it again', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.screen(screen('ordinary-working.txt'));
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const observer = observing(effects, job(), TERMINAL);
    await until('the observer to read the screen', () => fake.callsOf('read').length > 0);

    // The PM's ask_user call filed its questions; the observer turns them into one observation.
    expect(ask({ root, run: RUN_ID, key: job().key }, { questions })).toEqual({ ok: true, askId: 'ask-1' });
    expect(await until('the ask', () => asks(observer)[0])).toEqual({ type: 'OBS_ASKING', askId: 'ask-1', questions });
    expect(fs.readFileSync(reportedFile(agentDir(root, RUN_ID, job().key)), 'utf8').trim()).toBe('1');

    // A restarted observer re-reads asks.jsonl: the same ask is not put to the person twice (§5.7).
    observer.restart();
    await wait(200);
    expect(asks(observer)).toHaveLength(1);

    // A second round is a new ask, and it goes through.
    expect(ask({ root, run: RUN_ID, key: job().key }, { questions })).toEqual({ ok: true, askId: 'ask-2' });
    expect(await until('the second ask', () => asks(observer)[1])).toEqual({ type: 'OBS_ASKING', askId: 'ask-2', questions });
  });

  it('reports an ask that was already in the file when it started', async () => {
    const dir = tempDir();
    const root = path.join(dir, 'acme-api');
    const fake = fakeHc({ dir, address: TERMINAL });
    fake.events(workingEvents(TERMINAL));
    fake.screen(screen('ordinary-working.txt'));
    // The PM asked while the daemon was down: nothing may be lost on the way back up (§5.7).
    ask({ root, run: RUN_ID, key: job().key }, { questions });
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root, runId: RUN_ID });

    const observer = observing(effects, job(), TERMINAL);

    expect(await until('the ask', () => asks(observer)[0])).toEqual({ type: 'OBS_ASKING', askId: 'ask-1', questions });
    expect(fs.existsSync(asksFile(agentDir(root, RUN_ID, job().key)))).toBe(true);
  });
});

describe('hcEffects.sendToAgent and closeAgent', () => {
  it('pastes text into the terminal', async () => {
    const dir = tempDir();
    const fake = fakeHc({ dir });
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root: path.join(dir, 'acme-api'), runId: RUN_ID });

    const snapshot = await settled(effects.sendToAgent, { terminal: TERMINAL, text: 'fix the failing check' });
    expect(snapshot.status).toBe('done');
    expect(fake.callsOf('send')).toEqual([['send', TERMINAL, 'fix the failing check']]);
  });

  it('refuses a prompt choice the agent never showed', async () => {
    const dir = tempDir();
    const fake = fakeHc({ dir });
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root: path.join(dir, 'acme-api'), runId: RUN_ID });

    const snapshot = await settled(effects.sendToAgent, { terminal: 't-never-seen', keys: ['Trust this folder'] });
    expect(snapshot.status).toBe('error');
    expect(String(snapshot.error)).toContain('not waiting on a prompt');
    expect(fake.callsOf('keys')).toEqual([]);
  });

  it('kills and removes the terminal, and does nothing for a terminal it never had', async () => {
    const dir = tempDir();
    const fake = fakeHc({ dir });
    const effects = hcEffects({ hcBin: fake.bin, commandFor, pollMs: 10, root: path.join(dir, 'acme-api'), runId: RUN_ID });

    expect((await settled(effects.closeAgent, { terminal: TERMINAL })).status).toBe('done');
    expect(fake.calls()).toEqual([
      ['kill', TERMINAL],
      ['rm', TERMINAL],
    ]);

    // `CLOSE` can arrive before `launchAgent` reported a terminal (spec §5.5).
    expect((await settled(effects.closeAgent, { terminal: '' })).status).toBe('done');
    expect(fake.calls()).toHaveLength(2);
  });
});

describe('bin/bdc-adapt', () => {
  const adapt = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const options = { encoding: 'utf8' as const, stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'] };
    try {
      return { code: 0, stdout: execFileSync('sh', [BDC_ADAPT, ...args], options), stderr: '' };
    } catch (error) {
      const failed = error as { status?: number; stdout?: string; stderr?: string };
      return { code: failed.status ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  };

  const osc = (state: string): string => `\u001b]7501;state=${state}:app=bdc\u001b\\`;

  it('reports working before the CLI runs and done after it exits 0', () => {
    expect(adapt(['sh', '-c', 'echo hello'])).toEqual({
      code: 0,
      stdout: `${osc('working')}hello\n${osc('done')}`,
      stderr: '',
    });
  });

  it('reports blocked and keeps the exit code when the CLI fails', () => {
    expect(adapt(['sh', '-c', 'exit 3'])).toEqual({ code: 3, stdout: `${osc('working')}${osc('blocked')}`, stderr: '' });
  });

  it('prints its usage and exits 2 without a command', () => {
    const result = adapt([]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('usage: bdc-adapt');
  });
});

describe('closeRunTerminals', () => {
  it('kills and removes every terminal labelled with the run, live or finished, and no other', async () => {
    const { closeRunTerminals } = await import('../../src/effects/hc.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-close-run-'));
    try {
      const log = path.join(dir, 'calls.log');
      const bin = path.join(dir, 'hc');
      fs.writeFileSync(
        bin,
        `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = ls ]; then\n  case "$*" in *bdc.run=r-1*) echo '{"terminals":[{"address":"t1","state":"live"},{"address":"t2","state":"finished"}]}';; *) echo '{"terminals":[]}';; esac\nfi\n`,
      );
      fs.chmodSync(bin, 0o755);
      expect(await closeRunTerminals('r-1', bin)).toEqual(['t1', 't2']);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n');
      expect(calls[0]).toBe('ls --json --all --label bdc.run=r-1');
      expect(calls.slice(1)).toEqual(['kill t1', 'rm t1', 'kill t2', 'rm t2']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
