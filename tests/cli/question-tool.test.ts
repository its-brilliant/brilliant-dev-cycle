import { describe, expect, it } from 'vitest';
import type { Question } from '../../src/contracts/domain.js';
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

    expect(state.answers[0]).toEqual({ questionId: 'auth-provider', picked: ['google'], text: '', skipped: false });
    expect(state.screen).toBe(1);
  });

  it('picks an option by its number', () => {
    const state = press(startAsk([provider]), '2');

    expect(send(state)).toEqual({ answers: [{ questionId: 'auth-provider', picked: ['okta'], text: '', skipped: false }] });
  });

  it('toggles the options of a multi question and confirms them with Enter', () => {
    const toggled = type(startAsk([features]), ['1', '2', '1']);

    expect(toggled.picked).toEqual(['export']);
    expect(toggled.screen).toBe(0);
    expect(send(toggled)).toEqual({ answers: [{ questionId: 'features', picked: ['export'], text: '', skipped: false }] });
  });

  it('types a free answer after Other…', () => {
    const typed = type(startAsk([provider]), ['o', 'a', 'u', 't', 'h', '0', 'backspace']);

    expect(typed.typing).toBe(true);
    expect(typed.text).toBe('auth');
    expect(send(typed)).toEqual({ answers: [{ questionId: 'auth-provider', picked: [], text: 'auth', skipped: false }] });
  });

  it('leaves typing with Esc, keeping the choices one key away', () => {
    const state = type(startAsk([provider]), ['o', 'x', 'esc']);

    expect(state.typing).toBe(false);
    expect(send(type(state, ['2']))).toEqual({ answers: [{ questionId: 'auth-provider', picked: ['okta'], text: '', skipped: false }] });
  });

  it('types straight into a text question', () => {
    const state = startAsk([notes]);

    expect(state.typing).toBe(true);
    expect(send(type(state, ['n', 'o', 'n', 'e']))).toEqual({ answers: [{ questionId: 'notes', picked: [], text: 'none', skipped: false }] });
  });

  it('answers a confirm question with yes on Enter and no on 2', () => {
    expect(send(type(startAsk([understanding]), ['enter']))).toEqual({
      answers: [{ questionId: 'understanding', picked: ['yes'], text: '', skipped: false }],
    });
    expect(send(type(startAsk([understanding]), ['2']))).toEqual({
      answers: [{ questionId: 'understanding', picked: ['no'], text: '', skipped: false }],
    });
  });

  it('goes Back with the earlier answers kept', () => {
    const answered = type(startAsk([provider, database]), ['enter']);
    const back = press(answered, 'b');

    expect(back.screen).toBe(0);
    expect(back.answers[0]).toEqual({ questionId: 'auth-provider', picked: ['google'], text: '', skipped: false });
    expect(render(back, 80)).toContain('> 1  Google Workspace  (recommended)');

    // The earlier answer is still there when the person walks forward again.
    const forward = press(back, 'enter');
    expect(forward.screen).toBe(1);
    expect(forward.answers[0]).toEqual({ questionId: 'auth-provider', picked: ['google'], text: '', skipped: false });
  });

  it('does nothing on Back at the first question', () => {
    const state = press(startAsk([provider]), 'b');

    expect(state.screen).toBe(0);
    expect(state.answers).toEqual([null]);
  });

  it('skips a question', () => {
    expect(send(type(startAsk([provider, database]), ['s', 'enter']))).toEqual({
      answers: [
        { questionId: 'auth-provider', picked: [], text: '', skipped: true },
        { questionId: 'db', picked: ['postgres'], text: '', skipped: false },
      ],
    });
  });

  it('sends every question, in order, from the summary', () => {
    const state = type(startAsk([provider, features, notes, understanding]), ['enter', '2', 'enter', 'k', 'enter', 'enter']);

    expect(state.screen).toBe(4);
    expect(send(state)).toEqual({
      answers: [
        { questionId: 'auth-provider', picked: ['google'], text: '', skipped: false },
        { questionId: 'features', picked: ['export'], text: '', skipped: false },
        { questionId: 'notes', picked: [], text: 'k', skipped: false },
        { questionId: 'understanding', picked: ['yes'], text: '', skipped: false },
      ],
    });
  });

  it('sends nothing until the person presses Send on the summary', () => {
    const summary = type(startAsk([provider]), ['enter']);

    expect(result(summary)).toBeNull();
    expect(result(press(summary, 'enter'))).toEqual({
      answers: [{ questionId: 'auth-provider', picked: ['google'], text: '', skipped: false }],
    });
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

    const closed = question({ id: 'closed', title: 'Pick one', kind: 'single', options: [{ id: 'a', label: 'A' }], allowOther: false });
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
