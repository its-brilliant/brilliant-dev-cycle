/**
 * `bdc chat`: the PM chat and the question tool in a terminal (spec §3.4, §4.7, §9.4), until the
 * Herdr panel exists (slice 5).
 *
 * It only reads the run's view and sends person events: the transcript as it grows, the question
 * card when the PM asks (`view.asking`), one card per agent prompt (`view.agentPrompts`), and a
 * typed line as a message to the PM. The terminal is injected, so tests drive the whole session
 * without a TTY.
 */
import type { Answer, Question } from '../contracts/domain.js';
import { RunView } from '../contracts/view.js';
import { newRequestId, type DaemonClient } from '../daemon/client.js';
import { press, render, result, startAsk, type AskState } from './question-tool.js';

/**
 * The terminal as chat needs it: keys, raw mode, and erasing the card it redrew. `streamTerminal`
 * is the real one; tests hand in a queue of keys.
 */
export interface ChatTerminal {
  /** One key: a printable character, 'enter', 'backspace', 'esc' or 'ctrl-c'. Null when the input ends. */
  readKey(): Promise<string | null>;
  /** Raw mode while a question card owns the keys: no echo, no line buffering. */
  setRawMode(on: boolean): void;
  /** Erase the last `lines` lines already written, so a card redraws itself in place. */
  clear(lines: number): void;
  /** Give the terminal back: raw mode off, input paused. */
  close(): void;
}

export interface ChatOptions {
  client: Pick<DaemonClient, 'subscribe' | 'request' | 'onClose'>;
  runId: string;
  out(text: string): void;
  err(text: string): void;
  terminal: ChatTerminal;
  /** How wide a question card may be. */
  columns?: number;
  /** Stop the session: Ctrl-C from the caller, a test. */
  signal?: AbortSignal;
}

/** `bdc chat`: run until the person quits, the input ends or the daemon goes away. */
export async function runChat(options: ChatOptions): Promise<number> {
  const { client, runId, out, err, terminal } = options;
  const columns = options.columns ?? 80;
  const keys: string[] = [];
  const wake = new Wake();
  // Held in an object: the view and the end arrive from callbacks, so they must not be narrowed
  // to their first value at the point of use.
  const session: { view: RunView | null; stopped: boolean } = { view: null, stopped: false };
  let printedChat = 0;
  let shownStage = '';
  let line = '';
  const answeredAsks = new Set<string>();
  const answeredPrompts = new Set<string>();

  const stop = (): void => {
    session.stopped = true;
    wake.now();
  };
  const onAbort = (): void => stop();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) stop();
  const stopOnClose = client.onClose(stop);

  // One reader for the whole session: a card and the composer never compete for the input.
  void (async () => {
    for (;;) {
      const key = await terminal.readKey();
      keys.push(key === null ? END_OF_INPUT : key);
      wake.now();
      if (key === null) return;
    }
  })();

  /**
   * The next key, or null when the person interrupted or the input ended. A card owns the keys, so
   * it waits for them alone.
   */
  const nextKey = async (): Promise<string | null> => {
    for (;;) {
      if (session.stopped) return null;
      const key = keys.shift();
      if (key !== undefined) return key === END_OF_INPUT ? null : key;
      await wake.wait();
    }
  };

  const send = async (event: Record<string, unknown>): Promise<boolean> => {
    try {
      const response = await client.request({ id: newRequestId(), type: 'send', runId, event });
      if (response.ok) return true;
      err(`bdc: the daemon refused that: ${response.error}\n`);
      return false;
    } catch (error) {
      err(`bdc: ${message(error)}\n`);
      return false;
    }
  };

  /** The question card: keys until the person sends the summary. Null when the session ends. */
  const askQuestions = async (questions: Question[], options: { summary?: boolean } = {}): Promise<Answer[] | null> => {
    let state: AskState = startAsk(questions, options);
    let drawn = 0;
    const draw = (): void => {
      terminal.clear(drawn);
      const lines = render(state, columns);
      for (const text of lines) out(`${text}\n`);
      drawn = lines.length;
    };
    terminal.setRawMode(true);
    try {
      draw();
      for (;;) {
        const key = await nextKey();
        if (key === null || key === 'ctrl-c') return null;
        state = press(state, key);
        draw();
        const sent = result(state);
        if (sent !== null) return sent.answers;
      }
    } finally {
      terminal.setRawMode(false);
    }
  };

  /** The transcript and the stage line: only what the person has not seen yet. */
  const printChanges = (view: RunView): void => {
    for (const entry of view.chat.slice(printedChat)) {
      out(`${entry.from === 'pm' ? 'PM' : 'You'}: ${entry.text}\n`);
    }
    printedChat = view.chat.length;
    if (view.stageWords !== shownStage) {
      shownStage = view.stageWords;
      out(`\n${view.stageWords}\n`);
    }
  };

  /** The card for a waiting ask, then the event its answers become. Null to carry on. */
  const answerAsk = async (ask: NonNullable<RunView['asking']>): Promise<number | null> => {
    const answers = await askQuestions(ask.questions);
    if (answers === null) return 0;
    // An intake round answers the PM's turn; a scoped ask answers the phase or agent that asked.
    const event =
      ask.scope === null ? { type: 'ROUND_ANSWERED', answers } : { type: 'ANSWER', askId: ask.askId, answers };
    return (await send(event)) ? null : 1;
  };

  /** The card for one agent prompt, then PROMPT_CHOICE. Null to carry on. */
  const answerPrompt = async (prompt: RunView['agentPrompts'][number]): Promise<number | null> => {
    answeredPrompts.add(promptKey(prompt));
    // One question: the pick is the answer; no summary to confirm.
    const answers = await askQuestions([promptQuestion(prompt)], { summary: false });
    if (answers === null) return 0;
    const choice = answers[0]?.picked[0];
    // A skipped prompt sends nothing: the agent keeps waiting for the person.
    if (choice === undefined) return null;
    return (await send({ type: 'PROMPT_CHOICE', agentKey: prompt.agentKey, choice })) ? null : 1;
  };

  /** A prompt that left the view was answered; the same words later are a new question. */
  const forgetClearedPrompts = (prompts: RunView['agentPrompts']): void => {
    const showing = new Set(prompts.map(promptKey));
    for (const key of answeredPrompts) if (!showing.has(key)) answeredPrompts.delete(key);
  };

  /** What a line the person typed does. Null to carry on. */
  const runLine = async (text: string): Promise<number | null> => {
    if (text === '') return null;
    if (text === '/quit') return 0;
    if (text === '/status') {
      out(`${session.view?.stageWords ?? 'no view yet'}\n`);
      return null;
    }
    return (await send({ type: 'MESSAGE', text })) ? null : 1;
  };

  let unsubscribe: () => void;
  try {
    unsubscribe = await client.subscribe(runId, (raw) => {
      const parsed = RunView.safeParse(raw);
      if (!parsed.success) return;
      session.view = parsed.data;
      wake.now();
    });
  } catch (error) {
    err(`bdc: ${message(error)}\n`);
    stopOnClose();
    options.signal?.removeEventListener('abort', onAbort);
    return 1;
  }

  try {
    for (;;) {
      if (session.stopped) return 0;
      const view = session.view;
      if (view !== null) {
        printChanges(view);
        const ask = view.asking;
        if (ask !== null && !answeredAsks.has(ask.askId)) {
          answeredAsks.add(ask.askId);
          const code = await answerAsk(ask);
          if (code !== null) return code;
          continue;
        }
        const prompt = view.agentPrompts.find((entry) => !answeredPrompts.has(promptKey(entry)));
        if (prompt !== undefined) {
          const code = await answerPrompt(prompt);
          if (code !== null) return code;
          continue;
        }
        forgetClearedPrompts(view.agentPrompts);
      }

      // A new view or a key: either way the whole screen is looked at again.
      const key = keys.shift();
      if (key === undefined) {
        await wake.wait();
        continue;
      }
      if (key === END_OF_INPUT || key === 'ctrl-c') return 0;
      if (key === 'enter') {
        const text = line.trim();
        line = '';
        const code = await runLine(text);
        if (code !== null) return code;
        continue;
      }
      if (key === 'backspace') line = line.slice(0, -1);
      else if (key === 'esc') line = '';
      else if (key.length === 1) line += key;
    }
  } finally {
    unsubscribe();
    stopOnClose();
    options.signal?.removeEventListener('abort', onAbort);
    terminal.setRawMode(false);
  }
}

/** A key queue entry for "the input ended", so the queue can hold it like any other key. */
const END_OF_INPUT = '\u0000end';

/** A prompt from an agent (§9.1 rule 6), as a one-question card. Its choices are the option ids. */
export function promptQuestion(prompt: { agentKey: string; prompt: string; choices: string[] }): Question {
  // No recommendation: claude lists "No, exit" first, and Enter must never pick it by accident.
  return {
    id: prompt.agentKey,
    title: prompt.prompt,
    body: '',
    kind: 'single',
    options: prompt.choices.map((choice) => ({ id: choice, label: choice })),
    allowOther: false,
  };
}

function promptKey(prompt: { agentKey: string; prompt: string }): string {
  return `${prompt.agentKey}\u0000${prompt.prompt}`;
}

/** A wake-up between the reader, the view subscription and the session's end. */
class Wake {
  #pending = false;
  #waiters: Array<() => void> = [];

  /** Something changed. A wake nobody is waiting for is kept for the next `wait`. */
  now(): void {
    if (this.#waiters.length === 0) {
      this.#pending = true;
      return;
    }
    for (const resolve of this.#waiters) resolve();
    this.#waiters = [];
  }

  async wait(): Promise<void> {
    if (this.#pending) {
      this.#pending = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }
}

type KeyInput = NodeJS.ReadStream & { setRawMode?(mode: boolean): void };
type KeyOutput = { write(text: string): void; columns?: number };

/** The real terminal: keys one at a time, raw mode only while a card is up. */
export function streamTerminal(input: KeyInput = process.stdin, output: KeyOutput = process.stdout): ChatTerminal {
  const keys: string[] = [];
  const waiters: Array<(key: string | null) => void> = [];
  let closed = false;

  const deliver = (key: string): void => {
    const resolve = waiters.shift();
    if (resolve === undefined) keys.push(key);
    else resolve(key);
  };
  const onData = (chunk: string | Buffer): void => {
    for (const key of keysOf(String(chunk))) deliver(key);
  };
  const end = (): void => {
    for (const resolve of waiters.splice(0)) resolve(null);
  };
  const onSignal = (): void => deliver('ctrl-c');

  input.setEncoding('utf8');
  input.on('data', onData);
  input.on('end', end);
  process.on('SIGINT', onSignal);
  input.resume();

  return {
    readKey(): Promise<string | null> {
      const key = keys.shift();
      if (key !== undefined) return Promise.resolve(key);
      if (closed) return Promise.resolve(null);
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    setRawMode(on: boolean): void {
      input.setRawMode?.(on);
    },
    clear(lines: number): void {
      if (lines > 0) output.write(`\x1b[${lines}A\x1b[J`);
    },
    close(): void {
      if (closed) return;
      closed = true;
      input.off('data', onData);
      input.off('end', end);
      process.off('SIGINT', onSignal);
      input.setRawMode?.(false);
      input.pause();
      end();
    },
  };
}

/** Split one chunk of terminal input into keys. Arrow keys and other sequences are dropped. */
function keysOf(chunk: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < chunk.length; index += 1) {
    const char = chunk[index] ?? '';
    if (char === '\r') {
      keys.push('enter');
      if (chunk[index + 1] === '\n') index += 1;
    } else if (char === '\n') {
      keys.push('enter');
    } else if (char === '\x7f' || char === '\b') {
      keys.push('backspace');
    } else if (char === '\x03') {
      keys.push('ctrl-c');
    } else if (char === '\x1b') {
      const next = chunk[index + 1];
      if (next === '[' || next === 'O') {
        index += 1;
        while (index + 1 < chunk.length && !/[A-Za-z~]/.test(chunk[index + 1] ?? '')) index += 1;
        index += 1;
      } else {
        keys.push('esc');
      }
    } else if (char !== '\t') {
      keys.push(char);
    }
  }
  return keys;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
