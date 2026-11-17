/**
 * The prompts that block an agent on a person (spec §3.3): claude's folder trust prompt and its
 * tool permission prompt, and — with its own words — the numbered menu of any other CLI.
 *
 * This is the one thing bdc reads off a screen (§3.2 says results never come from the screen): a
 * trust or permission prompt is not reported through a submit tool, so the only sign that an agent
 * is waiting on a person is the terminal itself (`hc read`, src/effects/hc.ts).
 *
 * The choices are people words ("Trust this folder", "Don't allow"), because they become buttons in
 * PM chat (§9.4); the keys that pick them come from the numbered list on screen: the first option
 * is `enter`, the second `down enter`, the third `down down enter`, ...
 */

/** One option as the person sees it, with the keys that pick it in the terminal. */
export interface PromptChoice {
  label: string;
  keys: string[];
}

export interface DetectedPrompt {
  prompt: string;
  choices: PromptChoice[];
}

/** Only the bottom of the screen is read: a prompt that was answered scrolls up and stays there. */
const TAIL_LINES = 40;
/** How far above the options the question can be. */
const QUESTION_LOOKBACK = 12;
/** More options than this is not a trust or permission prompt. */
const MAX_OPTIONS = 5;
/** Short hint lines a CLI may print under the options (`Esc to cancel · Tab to amend`). */
const MAX_HINTS = 2;

/** SGR colours, OSC titles and cursor moves are not text. */
const ANSI = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[A-Za-z]/g;
/** The vertical edges of a dialog box, which are not part of a line's text. */
const LEFT_EDGE = /^\s*[│┃]\s?/;
const RIGHT_EDGE = /\s*[│┃]\s*$/;
/** A line of nothing but border: claude's trust prompt is a box, so its rules must not count as text. */
const BORDER = /^[\s─━╭╮╰╯┌┐└┘╔╗╚╝]*$/;

/** `1. Yes`, `❯ 2. No, exit`, `  3. No, and tell Claude what to do differently (esc)`. */
const OPTION = /^\s*(?:[❯›>]\s*)?(\d+)\.\s+(\S.*)$/;
/** claude 2.1's unnumbered menu: `❯ No, exit` with the cursor, `  Yes, I trust this folder` without. */
const CURSOR_OPTION = /^(\s*)[❯›]\s+(\S.*)$/;
const CURSOR = /^\s*[❯›>]/;

interface PromptKind {
  /** One of these lines on screen means this CLI is asking this question. */
  markers: string[];
  /** The question to show when the screen does not show one right above the options. */
  question: string;
  /** People words for the option at `index`, given the CLI's own wording. */
  label: (option: string, index: number) => string;
}

const TRUST: PromptKind = {
  markers: ['Do you trust the files in this folder', 'Quick safety check', 'Is this a project you created or one you trust'],
  question: 'Do you trust the files in this folder?',
  // By wording, not position: claude 2.1 lists "No, exit" first, and picking it ends the agent.
  label: (option) => (/^(no\b|don't|do not)/i.test(option.trim()) ? "Don't trust it" : 'Trust this folder'),
};

const PERMISSION: PromptKind = {
  markers: ['Do you want to proceed?', 'Do you want to make this edit'],
  question: 'Do you want to proceed?',
  label: (option, index) => {
    const wording = option.toLowerCase();
    if (wording.startsWith('no')) return "Don't allow";
    if (wording.includes("don't ask again") || wording.includes('allow all')) return "Allow and don't ask again";
    return index === 0 ? 'Allow' : option;
  },
};

/** claude first; every other CLI keeps its own words (pi's prompt wording is not recorded yet). */
const KINDS: PromptKind[] = [TRUST, PERMISSION];

/** The CLI's own option text, without the trailing key hint (`(shift+tab)`, `(esc)`). */
function ownWords(option: string): string {
  return option.replace(/\s+\((?:shift\+)?(?:tab|esc|enter)\)\s*$/i, '').trim();
}

/** The screen as text: no escape codes, no box borders, no trailing blanks. */
function screenLines(screen: string): string[] {
  return screen
    .replace(ANSI, '')
    .split('\n')
    .map((raw) => {
      const unboxed = raw.replace(LEFT_EDGE, ' ').replace(RIGHT_EDGE, '').replace(/\s+$/, '');
      return BORDER.test(unboxed) ? '' : unboxed;
    });
}

interface OptionList {
  /** Index in `lines` of the first option. */
  start: number;
  texts: string[];
  /** Which option the cursor is on now (0 when the screen shows no cursor). */
  cursor: number;
}

/** A numbered list that ends the screen: the shape every one of these prompts has. */
function optionList(lines: string[]): OptionList | null {
  let end = lines.length - 1;
  while (end >= 0 && lines[end] === '') end -= 1;
  const lastText = end;
  // A CLI may print a hint under its options; the agent's own output is never that short.
  for (let hints = 0; end >= 0 && hints < MAX_HINTS && OPTION.exec(lines[end] ?? '') === null; hints += 1) {
    end -= 1;
    while (end >= 0 && lines[end] === '') end -= 1;
  }
  const entries: Array<{ number: number; text: string }> = [];
  let index = end;
  while (index >= 0) {
    const match = OPTION.exec(lines[index] ?? '');
    if (match === null) break;
    entries.unshift({ number: Number(match[1]), text: (match[2] ?? '').trim() });
    index -= 1;
  }
  if (entries.length < 2 || entries.length > MAX_OPTIONS) return cursorList(lines, lastText);
  // Numbered 1..n from the top: a stray "3." in the output above the prompt is not an option.
  if (entries.some((entry, position) => entry.number !== position + 1)) return null;
  const start = index + 1;
  const marked = lines.slice(start, start + entries.length).findIndex((line) => CURSOR.test(line));
  return { start, texts: entries.map((entry) => entry.text), cursor: Math.max(marked, 0) };
}

/**
 * claude 2.1's unnumbered menu near the bottom of the screen (`lastText` is the last line with text):
 * a block of 2..MAX_OPTIONS lines where exactly one carries the cursor and the others are indented
 * to the same text column, followed by at most MAX_HINTS hint lines.
 */
function cursorList(lines: string[], lastText: number): OptionList | null {
  const lowest = Math.max(0, lastText - (MAX_OPTIONS + 2 * MAX_HINTS + 2));
  let cursorAt = -1;
  let column = -1;
  for (let index = lastText; index >= lowest; index -= 1) {
    const match = CURSOR_OPTION.exec(lines[index] ?? '');
    if (match !== null) {
      cursorAt = index;
      column = (lines[index] ?? '').indexOf(match[2] ?? '');
      break;
    }
  }
  if (cursorAt < 0) return null;
  const isOption = (line: string | undefined): boolean =>
    line !== undefined && line.trim() !== '' && !CURSOR.test(line) && line.search(/\S/) === column;
  let start = cursorAt;
  while (start - 1 >= 0 && isOption(lines[start - 1])) start -= 1;
  let last = cursorAt;
  while (last + 1 <= lastText && isOption(lines[last + 1])) last += 1;
  // Below the options only a short hint may follow (`Enter to confirm · Esc to cancel`).
  const below = lines.slice(last + 1, lastText + 1).filter((line) => line.trim() !== '');
  if (below.length > MAX_HINTS) return null;
  const texts = lines.slice(start, last + 1).map((line) => line.replace(CURSOR, '').trim());
  if (texts.length < 2 || texts.length > MAX_OPTIONS) return null;
  return { start, texts, cursor: cursorAt - start };
}

/** The question right above the options, if it is one. */
function questionAbove(lines: string[], listStart: number): string | null {
  for (let index = listStart - 1; index >= Math.max(0, listStart - QUESTION_LOOKBACK); index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (line === '') continue;
    return line.endsWith('?') && line.length <= 160 ? line : null;
  }
  return null;
}

/** From the cursor to the option, then Enter: on option 0 with the cursor on 0 that is just Enter. */
function keysFor(index: number, cursor: number): string[] {
  const moves = index - cursor;
  return [...Array<string>(Math.abs(moves)).fill(moves > 0 ? 'down' : 'up'), 'enter'];
}

/**
 * The prompt that blocks the agent on this screen, or null for an ordinary screen. `screen` is what
 * `hc read` prints, escape codes and all.
 */
export function detectPrompt(screen: string): DetectedPrompt | null {
  const tail = screenLines(screen).slice(-TAIL_LINES);
  const list = optionList(tail);
  if (list === null) return null;

  const question = questionAbove(tail, list.start);
  const kind = KINDS.find((candidate) => tail.some((line) => candidate.markers.some((marker) => line.includes(marker))));
  // An unknown CLI: a numbered yes/no menu under a question is still an agent waiting on a person.
  const generic = question !== null && list.texts.some((text) => /^yes\b/i.test(text)) && list.texts.some((text) => /^no\b/i.test(text));
  if (kind === undefined && !generic) return null;

  const prompt = question ?? kind?.question;
  if (prompt === undefined) return null;
  return {
    prompt,
    choices: list.texts.map((text, index) => ({
      label: kind === undefined ? ownWords(text) : kind.label(text, index),
      keys: keysFor(index, list.cursor),
    })),
  };
}
