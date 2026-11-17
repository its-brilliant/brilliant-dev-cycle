import { describe, expect, it } from 'vitest';
import type { Answer, Question } from '../../src/contracts/domain.js';
import { press, render, result, startAsk, type AskState } from '../../src/cli/question-tool.js';

function question(overrides: Partial<Question> & Pick<Question, 'id' | 'title' | 'kind'>): Question {
  return { body: '', options: [], allowOther: true, ...overrides };
}

const provider = question({
  id: 'auth-provider',
  title: 'Which sign-in provider?',
  body: 'Short context, one or two sentences.',
  kind: 'single',
  options: [
    { id: 'google', label: 'Google Workspace', hint: 'you already use it' },
    { id: 'okta', label: 'Okta' },
  ],
  recommended: 'google',
});

const database = question({
  id: 'db',
  title: 'Which database?',
  kind: 'single',
  options: [
    { id: 'postgres', label: 'Postgres' },
    { id: 'sqlite', label: 'SQLite' },
  ],
  recommended: 'postgres',
});

const features = question({
  id: 'features',
  title: 'Which features ship first?',
  kind: 'multi',
  options: [
    { id: 'search', label: 'Search' },
    { id: 'export', label: 'Export' },
  ],
  recommended: 'search',
});

const notes = question({ id: 'notes', title: 'Anything else?', kind: 'text' });
const understanding = question({ id: 'understanding', title: 'Did we get it right?', kind: 'confirm' });

/** One answer as the card sends it: options picked, text typed, or skipped. */
function answered(questionId: string, picked: string[] = [], text = ''): Answer {
  return { questionId, picked, text, skipped: false };
}

function skipped(questionId: string): Answer {
  return { questionId, picked: [], text: '', skipped: true };
}

/** Press a sequence of keys, as a person would. */
function type(state: AskState, keys: string[]): AskState {
  return keys.reduce((current, key) => press(current, key), state);
}

/**
 * The answers the card sends: Enter accepts a question's recommended answer or confirms its toggles,
 * and on the summary it sends. So a question at a time, until the answers come back.
 */
function send(state: AskState): unknown {
  let current = state;
  for (let step = 0; step <= state.questions.length; step += 1) {
    current = press(current, 'enter');
    const answers = result(current);
    if (answers !== null) return answers;
  }
  return result(current);
}

describe('the question tool', () => {
  it('starts on the first question with the recommended option marked', () => {
    const state = startAsk([provider, database]);

    expect(state.screen).toBe(0);
    expect(state.cursor).toBe(0);
    expect(render(state, 80)).toContain('> 1  Google Workspace  (recommended)');
  });

  it('accepts the recommended option with Enter and moves to the next question', () => {
    const state = press(startAsk([provider, database]), 'enter');

    expect(state.answers[0]).toEqual(answered('auth-provider', ['google']));
    expect(state.screen).toBe(1);
  });

  it('picks an option by its number', () => {
    const state = press(startAsk([provider]), '2');

    expect(send(state)).toEqual({ answers: [answered('auth-provider', ['okta'])] });
  });

  it('toggles the options of a multi question and confirms them with Enter', () => {
    const toggled = type(startAsk([features]), ['1', '2', '1']);

    expect(toggled.picked).toEqual(['export']);
    expect(toggled.screen).toBe(0);
    expect(send(toggled)).toEqual({ answers: [answered('features', ['export'])] });
  });

  it('types a free answer after Other…', () => {
    const typed = type(startAsk([provider]), ['o', 'a', 'u', 't', 'h', '0', 'backspace']);

    expect(typed.typing).toBe(true);
    expect(typed.text).toBe('auth');
    expect(send(typed)).toEqual({ answers: [answered('auth-provider', [], 'auth')] });
  });

  it('leaves typing with Esc, keeping the choices one key away', () => {
    const state = type(startAsk([provider]), ['o', 'x', 'esc']);

    expect(state.typing).toBe(false);
    expect(send(type(state, ['2']))).toEqual({ answers: [answered('auth-provider', ['okta'])] });
  });

  it('types straight into a text question', () => {
    const state = startAsk([notes]);

    expect(state.typing).toBe(true);
    expect(send(type(state, ['n', 'o', 'n', 'e']))).toEqual({ answers: [answered('notes', [], 'none')] });
  });

  it('answers a confirm question with yes on Enter and no on 2', () => {
    expect(send(type(startAsk([understanding]), ['enter']))).toEqual({ answers: [answered('understanding', ['yes'])] });
    expect(send(type(startAsk([understanding]), ['2']))).toEqual({ answers: [answered('understanding', ['no'])] });
  });

  it('goes Back with the earlier answers kept', () => {
    const firstAnswer = type(startAsk([provider, database]), ['enter']);
    const back = press(firstAnswer, 'b');

    expect(back.screen).toBe(0);
    expect(back.answers[0]).toEqual(answered('auth-provider', ['google']));
    expect(render(back, 80)).toContain('> 1  Google Workspace  (recommended)');

    // The earlier answer is still there when the person walks forward again.
    const forward = press(back, 'enter');
    expect(forward.screen).toBe(1);
    expect(forward.answers[0]).toEqual(answered('auth-provider', ['google']));
  });

  it('does nothing on Back at the first question', () => {
    const state = press(startAsk([provider]), 'b');

    expect(state.screen).toBe(0);
    expect(state.answers).toEqual([null]);
  });

  it('skips a question', () => {
    expect(send(type(startAsk([provider, database]), ['s', 'enter']))).toEqual({
      answers: [skipped('auth-provider'), answered('db', ['postgres'])],
    });
  });

  it('sends every question, in order, from the summary', () => {
    const state = type(startAsk([provider, features, notes, understanding]), [
      'enter',
      '2',
      'enter',
      'k',
      'enter',
      'enter',
    ]);

    expect(state.screen).toBe(4);
    expect(send(state)).toEqual({
      answers: [
        answered('auth-provider', ['google']),
        answered('features', ['export']),
        answered('notes', [], 'k'),
        answered('understanding', ['yes']),
      ],
    });
  });

  it('sends nothing until the person presses Send on the summary', () => {
    const summary = type(startAsk([provider]), ['enter']);

    expect(result(summary)).toBeNull();
    expect(result(press(summary, 'enter'))).toEqual({ answers: [answered('auth-provider', ['google'])] });
  });

  it('ignores keys after Send', () => {
    const sent = type(startAsk([provider]), ['enter', 'enter']);

    expect(press(sent, 'b')).toEqual(sent);
  });

  it('sends an empty answer list for an empty ask', () => {
    expect(send(startAsk([]))).toEqual({ answers: [] });
  });
});

describe('the question card', () => {
  it('says where the person is, and what the option is for', () => {
    const lines = render(press(startAsk([provider, database, notes, understanding]), 'enter'), 80);

    expect(lines[0]).toBe('Question 2 of 4');
    expect(lines).toContain('Which database?');
    expect(lines).toContain('> 1  Postgres  (recommended)');
    expect(lines).toContain('  2  SQLite');
    expect(lines.join('\n')).toContain('Enter for Postgres');
  });

  it('shows people words only: no question or option ids', () => {
    const first = render(startAsk([provider, database]), 80).join('\n');
    const second = render(press(startAsk([provider, database]), 'enter'), 80).join('\n');

    expect(first).toContain('Google Workspace');
    for (const text of [first, second]) {
      expect(text).not.toContain('auth-provider');
      expect(text).not.toContain('google');
      expect(text).not.toContain('okta');
      expect(text).not.toContain('postgres');
    }
    expect(second).toContain('Postgres');
  });

  it('wraps the body to the width it is given', () => {
    const body = 'This is a sentence that has to be wrapped because it is much longer than the width the card has.';
    const long = question({ id: 'long', title: 'Why?', kind: 'single', body, options: [{ id: 'a', label: 'A' }] });

    const lines = render(startAsk([long]), 40);
    const wrapped = lines.slice(3, lines.indexOf('', 3));

    expect(wrapped.length).toBeGreaterThan(1);
    for (const line of wrapped) expect(line.length).toBeLessThanOrEqual(40);
    expect(wrapped.join(' ')).toBe(body);
  });

  it('marks toggles on a multi question and offers Other… only when it is allowed', () => {
    const multi = render(press(startAsk([features]), '1'), 80);
    expect(multi).toContain('> [x] 1  Search  (recommended)');
    expect(multi).toContain('  [ ] 2  Export');
    expect(multi.join('\n')).toContain('Other…');

    const closed = question({
      id: 'closed',
      title: 'Pick one',
      kind: 'single',
      options: [{ id: 'a', label: 'A' }],
      allowOther: false,
    });
    expect(render(startAsk([closed]), 80).join('\n')).not.toContain('Other…');
  });

  it('shows the typed answer while typing', () => {
    const lines = render(type(startAsk([provider]), ['o', 'g', 'i', 't']), 80);

    expect(lines).toContain('Your answer: git');
    expect(lines.join('\n')).toContain('Esc to go back to the choices');
  });

  it('summarises every answer on one line before Send', () => {
    const summary = render(type(startAsk([provider, database]), ['enter', '2']), 80);

    expect(summary).toContain('Which sign-in provider? → Google Workspace');
    expect(summary).toContain('Which database? → SQLite');
    expect(summary.join('\n')).toContain('Enter to send');
  });
});

/** Found in the first real grill-me run (17 Nov 2026). */
describe('question tool fixes from the first real run', () => {
  const multi: Question = {
    id: 'extras',
    title: 'Which extras?',
    body: '',
    kind: 'multi',
    options: [{ id: 'help', label: '--help' }, { id: 'tests', label: 'Tests', hint: 'node:test, no dependencies' }],
    allowOther: true,
  };

  it('shows the hint the PM wrote under an option', () => {
    const lines = render(startAsk([multi]), 100);
    expect(lines.some((line) => line.includes('node:test, no dependencies'))).toBe(true);
  });

  it('a one-question card can send on its answer, without a summary screen', () => {
    const single: Question = { id: 'trust', title: 'Trust this folder?', body: '', kind: 'single', options: [{ id: 'yes', label: 'Trust' }, { id: 'no', label: "Don't" }], allowOther: false };
    const state = press(startAsk([single], { summary: false }), '1');
    expect(result(state)?.answers).toEqual([{ questionId: 'trust', picked: ['yes'], text: '', skipped: false }]);
  });
});

describe('agent prompt cards', () => {
  it('recommend nothing, so Enter cannot pick "Don\'t trust it" by accident', async () => {
    const { promptQuestion } = await import('../../src/cli/chat.js');
    const question = promptQuestion({ agentKey: 'r1/pm', prompt: 'Do you trust the files in this folder?', choices: ["Don't trust it", 'Trust this folder'] });
    expect(question.recommended).toBeUndefined();
    const state = press(startAsk([question], { summary: false }), 'enter');
    expect(result(state)).toBeNull();
  });
});
