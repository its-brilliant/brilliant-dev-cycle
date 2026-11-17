import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assign, setup, type AnyStateMachine, type SnapshotFrom } from 'xstate';
import type { Question } from '../../src/contracts/domain.js';
import type { RunView } from '../../src/contracts/view.js';
import { runChat, type ChatTerminal } from '../../src/cli/chat.js';
import { main, type CliIO } from '../../src/cli/main.js';
import { connect } from '../../src/daemon/client.js';
import { RunHost } from '../../src/daemon/host.js';
import { projectPaths, type ProjectPaths } from '../../src/daemon/paths.js';
import { startDaemon, type Daemon } from '../../src/daemon/server.js';
import { RunStore, type JsonValue } from '../../src/daemon/store.js';

const RUN_ID = 'run-1';

/** A run whose whole view the test sets, so chat sees exactly the screen it should react to. */
const screenMachine: AnyStateMachine = setup({
  types: { context: {} as { view: RunView }, events: {} as { type: string; view?: RunView } },
  actions: { show: assign({ view: ({ context, event }) => event.view ?? context.view }) },
}).createMachine({
  id: 'screen',
  initial: 'showing',
  context: () => ({ view: emptyView() }),
  states: { showing: { on: { SHOW: { actions: 'show' }, MESSAGE: {} } } },
});

function emptyView(overrides: Partial<RunView> = {}): RunView {
  return {
    runId: RUN_ID,
    goal: 'ship it',
    stage: 'intake',
    stageWords: 'Getting the goal straight',
    paused: false,
    needsYou: false,
    error: null,
    asking: null,
    agentPrompts: [],
    chat: [],
    proposals: [],
    brief: null,
    spec: null,
    plan: null,
    phases: [],
    finalFindings: [],
    pullRequest: null,
    ...overrides,
  };
}

const provider: Question = {
  id: 'auth-provider',
  title: 'Which sign-in provider?',
  body: '',
  kind: 'single',
  options: [
    { id: 'google', label: 'Google Workspace' },
    { id: 'okta', label: 'Okta' },
  ],
  recommended: 'google',
  allowOther: true,
};

/** A terminal a test drives: keys go in, raw mode and cleared lines are recorded. */
class FakeTerminal implements ChatTerminal {
  readonly rawModes: boolean[] = [];
  readonly cleared: number[] = [];
  readonly #keys: string[] = [];
  readonly #waiters: Array<(key: string | null) => void> = [];
  #closed = false;

  readKey(): Promise<string | null> {
    const key = this.#keys.shift();
    if (key !== undefined) return Promise.resolve(key);
    if (this.#closed) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** Feed keys as the person presses them; a key pressed before it is wanted waits in the queue. */
  press(...keys: string[]): void {
    for (const key of keys) {
      const resolve = this.#waiters.shift();
      if (resolve === undefined) this.#keys.push(key);
      else resolve(key);
    }
  }

  setRawMode(on: boolean): void {
    this.rawModes.push(on);
  }

  clear(lines: number): void {
    this.cleared.push(lines);
  }

  close(): void {
    this.#closed = true;
    for (const resolve of this.#waiters.splice(0)) resolve(null);
  }
}

let root: string;
let paths: ProjectPaths;
let store: RunStore;
let host: RunHost;
let daemon: Daemon;

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-chat-'));
  paths = projectPaths(root);
  store = new RunStore(paths.run(RUN_ID), 1);
  host = new RunHost({
    machine: screenMachine,
    machineVersion: 1,
    input: {},
    store,
    project: (snapshot: SnapshotFrom<AnyStateMachine>) => (snapshot.context as { view: RunView }).view as unknown as JsonValue,
  });
  host.start();
  daemon = await startDaemon({ root, hostFor: (runId) => (runId === RUN_ID ? host : undefined), runs: () => [RUN_ID] });
});

afterEach(async () => {
  await daemon.stopDaemon();
  host.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function show(view: RunView): void {
  host.send({ type: 'SHOW', view });
}

/** Person events the daemon accepted, without the test's own SHOWs. */
function personEvents(): Array<Record<string, unknown>> {
  return store.readEvents().filter((event) => event.type !== 'SHOW');
}

interface Session {
  terminal: FakeTerminal;
  out: string[];
  err: string[];
  chat: Promise<number>;
  stop(): void;
}

async function startSession(): Promise<Session> {
  const controller = new AbortController();
  const terminal = new FakeTerminal();
  const out: string[] = [];
  const err: string[] = [];
  const client = await connect(root);
  const chat = runChat({
    client,
    runId: RUN_ID,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    terminal,
    columns: 80,
    signal: controller.signal,
  });
  return {
    terminal,
    out,
    err,
    chat,
    stop(): void {
      controller.abort();
      terminal.close();
      client.close();
    },
  };
}

function printed(lines: string[]): string {
  return lines.join('');
}

/** The lines that say where the run is, however they were written. */
function stageLines(lines: string[]): string[] {
  return lines.filter((text) => text.includes('Getting the goal straight'));
}

function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

describe('bdc chat', () => {
  it('prints the chat as it grows, once per line, and the stage words when they change', async () => {
    const session = await startSession();
    try {
      show(emptyView({ chat: [{ from: 'pm', text: 'What are we building?' }] }));
      await vi.waitFor(() => expect(printed(session.out)).toContain('PM: What are we building?'));
      expect(printed(session.out)).toContain('Getting the goal straight');

      show(emptyView({ chat: [{ from: 'pm', text: 'What are we building?' }, { from: 'you', text: 'A CLI' }] }));
      await vi.waitFor(() => expect(printed(session.out)).toContain('You: A CLI'));

      show(
        emptyView({
          stage: 'specDrafting',
          stageWords: 'Writing the spec',
          chat: [
            { from: 'pm', text: 'What are we building?' },
            { from: 'you', text: 'A CLI' },
          ],
        }),
      );
      await vi.waitFor(() => expect(printed(session.out)).toContain('Writing the spec'));

      expect(session.out.filter((text) => text === 'PM: What are we building?\n')).toHaveLength(1);
      expect(session.out.filter((text) => text === 'You: A CLI\n')).toHaveLength(1);
    } finally {
      session.stop();
    }
    expect(await session.chat).toBe(0);
  });

  it('asks the intake questions with the question tool and sends ROUND_ANSWERED', async () => {
    const session = await startSession();
    try {
      show(emptyView({ needsYou: true, asking: { askId: 'ask-1', scope: null, questions: [provider] } }));
      await vi.waitFor(() => expect(printed(session.out)).toContain('Question 1 of 1'));

      session.terminal.press('enter', 'enter');

      await vi.waitFor(() =>
        expect(personEvents()).toContainEqual({
          type: 'ROUND_ANSWERED',
          answers: [{ questionId: 'auth-provider', picked: ['google'], text: '', skipped: false }],
          at: expect.any(String),
        }),
      );
      expect(session.terminal.rawModes).toEqual([true, false]);
    } finally {
      session.stop();
    }
    expect(await session.chat).toBe(0);
  });

  it('answers a scoped ask with ANSWER and its askId', async () => {
    const session = await startSession();
    try {
      show(emptyView({ needsYou: true, asking: { askId: 'ask-7', scope: 'phase-2', questions: [provider] } }));
      await vi.waitFor(() => expect(printed(session.out)).toContain('Question 1 of 1'));

      session.terminal.press('2', 'enter');

      await vi.waitFor(() =>
        expect(personEvents()).toContainEqual({
          type: 'ANSWER',
          askId: 'ask-7',
          answers: [{ questionId: 'auth-provider', picked: ['okta'], text: '', skipped: false }],
          at: expect.any(String),
        }),
      );
    } finally {
      session.stop();
    }
    expect(await session.chat).toBe(0);
  });

  it('asks each agent prompt as one card and sends PROMPT_CHOICE', async () => {
    const session = await startSession();
    try {
      show(
        emptyView({
          needsYou: true,
          agentPrompts: [{ agentKey: 'builder-1', prompt: 'Allow running the tests?', choices: ['Yes', 'No'] }],
        }),
      );
      await vi.waitFor(() => expect(printed(session.out)).toContain('Allow running the tests?'));
      expect(printed(session.out)).toContain('1  Yes');
      expect(printed(session.out)).toContain('2  No');

      session.terminal.press('2', 'enter');

      await vi.waitFor(() =>
        expect(personEvents()).toContainEqual({
          type: 'PROMPT_CHOICE',
          agentKey: 'builder-1',
          choice: 'No',
          at: expect.any(String),
        }),
      );
    } finally {
      session.stop();
    }
    expect(await session.chat).toBe(0);
  });

  it('sends a typed line as a message to the PM', async () => {
    const session = await startSession();
    try {
      show(emptyView());
      await vi.waitFor(() => expect(printed(session.out)).toContain('Getting the goal straight'));

      session.terminal.press('h', 'i', 'backspace', 'o', 'enter');

      await vi.waitFor(() =>
        expect(personEvents()).toContainEqual({ type: 'MESSAGE', text: 'ho', at: expect.any(String) }),
      );
    } finally {
      session.stop();
    }
    expect(await session.chat).toBe(0);
  });

  it('prints the stage words for /status and sends nothing for an empty line', async () => {
    const session = await startSession();
    try {
      show(emptyView());
      await vi.waitFor(() => expect(printed(session.out)).toContain('Getting the goal straight'));

      session.terminal.press('enter', '/', 's', 't', 'a', 't', 'u', 's', 'enter');

      await vi.waitFor(() => expect(stageLines(session.out)).toHaveLength(2));
      expect(personEvents()).toEqual([]);
    } finally {
      session.stop();
    }
    expect(await session.chat).toBe(0);
  });

  it('leaves with /quit and answers 0', async () => {
    const session = await startSession();
    show(emptyView());
    await vi.waitFor(() => expect(printed(session.out)).toContain('Getting the goal straight'));

    session.terminal.press('/', 'q', 'u', 'i', 't', 'enter');

    expect(await session.chat).toBe(0);
    expect(personEvents()).toEqual([]);
    session.stop();
  });

  it('leaves on Ctrl-C with the terminal given back', async () => {
    const session = await startSession();
    try {
      show(emptyView({ needsYou: true, asking: { askId: 'ask-1', scope: null, questions: [provider] } }));
      await vi.waitFor(() => expect(printed(session.out)).toContain('Question 1 of 1'));

      session.terminal.press('ctrl-c');

      expect(await session.chat).toBe(0);
      expect(session.terminal.rawModes.at(-1)).toBe(false);
      expect(personEvents()).toEqual([]);
    } finally {
      session.stop();
    }
  });
});

describe('bdc say', () => {
  it('sends one message to the latest run', async () => {
    const { io, out, err } = captureIO();

    expect(await main(['say', root, 'keep phase 2 up'], io)).toBe(0);

    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(personEvents()).toContainEqual({ type: 'MESSAGE', text: 'keep phase 2 up', at: expect.any(String) });
  });

  it('answers the command line it cannot use with exit code 2', async () => {
    const { io, err } = captureIO();

    expect(await main(['say', root], io)).toBe(2);
    expect(await main(['say', root, '   '], io)).toBe(2);
    expect(await main(['say', root, 'one', 'two'], io)).toBe(2);
    expect(await main(['chat'], io)).toBe(2);
    expect(await main(['chat', root, 'somewhere-else'], io)).toBe(2);
    expect(await main(['chat', root, '--wat'], io)).toBe(2);

    expect(err.join('')).toContain('say needs a message');
    expect(err.join('')).toContain('say takes a project directory and one message');
    expect(err.join('')).toContain('chat needs the project directory');
    expect(err.join('')).toContain('chat takes one project directory');
    expect(err.join('')).toContain('unknown option: --wat');
    expect(personEvents()).toEqual([]);
  });

  it('answers exit code 1 when the daemon refuses the message', async () => {
    const { io, err } = captureIO();

    expect(await main(['say', root, 'hello', '--run', 'run-9'], io)).toBe(1);

    expect(err.join('')).toContain('unknown run: run-9');
  });
});
