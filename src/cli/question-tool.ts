/**
 * The question tool (spec §3.4, §9.4) without a terminal: one ask's questions, answered one at a
 * time by key presses. `startAsk` → `press` → `render`, and `result` once the person sends.
 *
 * The state is plain JSON and the keys are strings ('1'–'9', 'enter', 'backspace', 'esc', 'b', 's',
 * 'o', or any printable character), so tests drive the whole card without a TTY and the Herdr
 * panel (slice 5) can render the same state.
 */
import type { Answer, Question } from '../contracts/domain.js';

/** A printable character, or one of the named keys a terminal reports. */
export type Key = string;

export const ENTER = 'enter';
export const BACKSPACE = 'backspace';
export const ESC = 'esc';
export const BACK = 'b';
export const SKIP = 's';
export const OTHER = 'o';

export interface AskState {
  questions: Question[];
  /** One answer per question, in order; null until the person answers that question. */
  answers: (Answer | null)[];
  /** The question on screen; `questions.length` is the summary. */
  screen: number;
  /** True while the person types a free answer (Other…, or a `text` question). */
  typing: boolean;
  /** What is typed so far. */
  text: string;
  /** The option the selection mark is on. */
  cursor: number;
  /** The multi question's toggles so far. */
  picked: string[];
  /** True once the person pressed Send on the summary. */
  sent: boolean;
  /** Whether answering the last question shows the summary first. A one-question agent prompt does not. */
  summary: boolean;
}

/** The answer to the question on screen. */
export interface AskResult {
  /** The person pressed Send: every question has an answer (unanswered ones count as skipped). */
  answers: Answer[];
}

/** A question's options as the card shows them. `confirm` always has Yes and No (spec §3.4). */
export function optionsOf(question: Question): Array<{ id: string; label: string; hint?: string }> {
  if (question.kind === 'text') return [];
  if (question.options.length > 0) return question.options;
  if (question.kind === 'confirm') {
    return [
      { id: 'yes', label: 'Yes' },
      { id: 'no', label: 'No' },
    ];
  }
  return [];
}

export function startAsk(questions: Question[], options: { summary?: boolean } = {}): AskState {
  const state: AskState = {
    summary: options.summary ?? true,
    questions,
    answers: questions.map(() => null),
    screen: 0,
    typing: false,
    text: '',
    cursor: 0,
    picked: [],
    sent: false,
  };
  return enterQuestion(state, 0);
}

/** The answer the card would send now, or null while the person is still answering. */
export function result(state: AskState): AskResult | null {
  if (!state.sent) return null;
  return {
    answers: state.questions.map(
      (question, index) => state.answers[index] ?? { questionId: question.id, picked: [], text: '', skipped: true },
    ),
  };
}

export function press(state: AskState, key: Key): AskState {
  if (state.sent) return state;
  if (state.screen >= state.questions.length) return pressSummary(state, key);
  return state.typing ? pressTyping(state, key) : pressOptions(state, key);
}

/** The card, as lines: header, title, body, the options, and the keys that work now. */
export function render(state: AskState, width: number): string[] {
  if (state.screen >= state.questions.length) return renderSummary(state, width);
  const question = state.questions[state.screen];
  if (question === undefined) return renderSummary(state, width);

  const lines = [`Question ${state.screen + 1} of ${state.questions.length}`, ...wrap(question.title, width)];
  if (question.body.trim() !== '') lines.push('', ...wrap(question.body, width));
  lines.push('');
  if (state.typing) {
    lines.push(...renderTyping(state, question));
  } else {
    lines.push(...renderOptions(state, question));
  }
  lines.push('', hint(state, question));
  return lines;
}

function enterQuestion(state: AskState, index: number): AskState {
  const question = state.questions[index];
  if (question === undefined) {
    const done = { ...state, screen: state.questions.length, typing: false, text: '', picked: [], cursor: 0 };
    return state.summary ? done : { ...done, sent: true };
  }
  const previous = state.answers[index] ?? null;
  const picked = previous?.picked ?? [];
  const text = previous?.text ?? '';
  const options = optionsOf(question);
  const marked = options.findIndex((option) => picked.includes(option.id) || option.id === question.recommended);
  return {
    ...state,
    screen: index,
    typing: question.kind === 'text' || text !== '',
    text,
    picked,
    cursor: marked < 0 ? 0 : marked,
  };
}

function pressSummary(state: AskState, key: Key): AskState {
  if (key === ENTER) return { ...state, sent: true };
  if (key === BACK && state.questions.length > 0) return enterQuestion(state, state.questions.length - 1);
  return state;
}

function pressTyping(state: AskState, key: Key): AskState {
  if (key === ENTER) {
    return answerAndAdvance(state, { picked: [], text: state.text, skipped: state.text.trim() === '' });
  }
  if (key === BACKSPACE) return { ...state, text: state.text.slice(0, -1) };
  if (key === ESC) return { ...state, typing: false };
  if (isPrintable(key)) return { ...state, text: state.text + key };
  return state;
}

function pressOptions(state: AskState, key: Key): AskState {
  const question = state.questions[state.screen];
  if (question === undefined) return state;
  const options = optionsOf(question);

  if (key.length === 1 && key >= '1' && key <= '9') {
    const index = Number(key) - 1;
    const option = options[index];
    if (option === undefined) return state;
    if (question.kind === 'multi') {
      const picked = state.picked.includes(option.id)
        ? state.picked.filter((id) => id !== option.id)
        : [...state.picked, option.id];
      return { ...state, picked, cursor: index };
    }
    return answerAndAdvance(state, { picked: [option.id], text: '', skipped: false });
  }

  switch (key) {
    case ENTER: {
      if (question.kind === 'multi') return answerAndAdvance(state, { picked: state.picked, text: '', skipped: false });
      if (question.kind === 'text') return { ...state, typing: true };
      // Enter accepts the recommended answer (§3.4). Without one Enter does nothing: an agent's trust
      // prompt lists "Don't trust it" first, and Enter must never pick that by accident.
      const recommended = options.find((option) => option.id === question.recommended);
      const chosen = question.kind === 'confirm' ? options[0] : recommended;
      if (chosen === undefined) return state;
      return answerAndAdvance(state, { picked: [chosen.id], text: '', skipped: false });
    }
    case OTHER:
      if (!question.allowOther) return state;
      return { ...state, typing: true };
    case BACK:
      return state.screen > 0 ? enterQuestion(state, state.screen - 1) : state;
    case SKIP:
      return answerAndAdvance(state, { picked: [], text: '', skipped: true });
    default:
      return state;
  }
}

function answerAndAdvance(state: AskState, answer: Omit<Answer, 'questionId'>): AskState {
  const question = state.questions[state.screen];
  if (question === undefined) return state;
  const answers = [...state.answers];
  answers[state.screen] = { questionId: question.id, ...answer };
  return enterQuestion({ ...state, answers }, state.screen + 1);
}

function renderTyping(state: AskState, question: Question): string[] {
  const lines = [`Your answer: ${state.text}`];
  const others = optionsOf(question);
  if (others.length > 0) {
    lines.push('', 'instead of one of these:');
    for (const option of others) {
      lines.push(`  ${option.label}${option.id === question.recommended ? '  (recommended)' : ''}`);
    }
  }
  return lines;
}

function renderOptions(state: AskState, question: Question): string[] {
  const lines: string[] = [];
  const options = optionsOf(question);
  options.forEach((option, index) => {
    const mark = index === state.cursor ? '>' : ' ';
    const toggled = question.kind === 'multi' ? `[${state.picked.includes(option.id) ? 'x' : ' '}] ` : '';
    const recommended = option.id === question.recommended ? '  (recommended)' : '';
    lines.push(`${mark} ${toggled}${index + 1}  ${option.label}${recommended}`);
    // The PM's hint is what tells two options apart ("one file plus package.json"); keep it.
    if (option.hint !== undefined && option.hint.trim() !== '') lines.push(`       ${option.hint.trim()}`);
  });
  if (question.allowOther && question.kind !== 'text') lines.push(`  ${OTHER}  Other…`);
  return lines;
}

function renderSummary(state: AskState, width: number): string[] {
  const lines = ['Here are your answers', ''];
  state.questions.forEach((question, index) => {
    const words = answerWords(question, state.answers[index] ?? null);
    lines.push(...wrap(`${question.title} → ${words}`, width));
  });
  lines.push('', state.sent ? 'Sent.' : 'Enter to send, b to change an answer');
  return lines;
}

/** One answer in people words: the option labels, the typed text, "skipped" (spec §9.1 rule 4). */
function answerWords(question: Question, answer: Answer | null): string {
  if (answer === null) return 'not answered yet';
  if (answer.skipped) return 'skipped';
  if (answer.text !== '') return answer.text;
  if (answer.picked.length === 0) return 'none';
  return answer.picked
    .map((id) => optionsOf(question).find((option) => option.id === id)?.label ?? id)
    .join(', ');
}

/** The keys that do something now; a key that would do nothing is not offered (spec §9.1 rule 3). */
function hint(state: AskState, question: Question): string {
  if (state.typing) {
    const parts = ['Type your answer', 'Enter to keep it', 'Esc to go back to the choices'];
    return parts.join(', ');
  }
  const parts: string[] = [];
  if (question.kind === 'multi') parts.push('1–9 to choose', 'Enter when you are done');
  else if (question.kind === 'text') parts.push('Enter to type your answer');
  else {
    parts.push('1–9 to pick');
    const recommended = optionsOf(question).find((option) => option.id === question.recommended);
    if (question.kind === 'confirm') parts.push('Enter for yes');
    else if (recommended !== undefined) parts.push(`Enter for ${recommended.label}`);
    if (question.allowOther) parts.push(`${OTHER} to type your own answer`);
  }
  if (state.screen > 0) parts.push(`${BACK} to go back`);
  parts.push(`${SKIP} to skip`);
  return parts.join(', ');
}

/** Break text into lines of at most `width` characters, on spaces. */
function wrap(text: string, width: number): string[] {
  const limit = Math.max(20, width);
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((part) => part !== '')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= limit) line = `${line} ${word}`;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines.length === 0 ? [''] : lines;
}

function isPrintable(key: Key): boolean {
  return key.length === 1 && key >= ' ' && key !== '\x7f';
}
