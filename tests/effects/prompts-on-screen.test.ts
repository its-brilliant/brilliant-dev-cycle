import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { detectPrompt } from '../../src/effects/prompts-on-screen.js';

/** Screens are written from the strings claude and other CLIs show (no claude was run for them). */
const screen = (name: string): string => readFileSync(new URL(`../fixtures/screens/${name}`, import.meta.url), 'utf8');

describe('detectPrompt', () => {
  it('reads the folder trust prompt as people words, Enter for trust and Down Enter for no', () => {
    expect(detectPrompt(screen('claude-trust.txt'))).toEqual({
      prompt: 'Do you trust the files in this folder?',
      choices: [
        { label: 'Trust this folder', keys: ['enter'] },
        { label: "Don't trust it", keys: ['down', 'enter'] },
      ],
    });
  });

  it('reads a tool permission prompt with its three answers and the keys that pick them', () => {
    expect(detectPrompt(screen('claude-permission-bash.txt'))).toEqual({
      prompt: 'Do you want to proceed?',
      choices: [
        { label: 'Allow', keys: ['enter'] },
        { label: "Allow and don't ask again", keys: ['down', 'enter'] },
        { label: "Don't allow", keys: ['down', 'down', 'enter'] },
      ],
    });
  });

  it('reads an edit permission prompt and keeps its own question', () => {
    expect(detectPrompt(screen('claude-permission-edit.txt'))).toEqual({
      prompt: 'Do you want to make this edit to src/hello.sh?',
      choices: [
        { label: 'Allow', keys: ['enter'] },
        { label: "Allow and don't ask again", keys: ['down', 'enter'] },
        { label: "Don't allow", keys: ['down', 'down', 'enter'] },
      ],
    });
  });

  it('reads a numbered yes/no menu of a CLI whose wording bdc does not know (pi)', () => {
    expect(detectPrompt(screen('other-cli-menu.txt'))).toEqual({
      prompt: 'Allow this command?',
      choices: [
        { label: 'Yes', keys: ['enter'] },
        { label: "Yes, don't ask again", keys: ['down', 'enter'] },
        { label: 'No', keys: ['down', 'down', 'enter'] },
      ],
    });
  });

  it.each(['ordinary-working.txt', 'ordinary-numbered-output.txt', 'ordinary-answered-prompt.txt'])(
    'answers null for %s, which is an agent at work',
    (name) => {
      expect(detectPrompt(screen(name))).toBeNull();
    },
  );

  it('answers null for an empty screen and for a screen of nothing but a border', () => {
    expect(detectPrompt('')).toBeNull();
    expect(detectPrompt('╭──────────────╮\n│              │\n╰──────────────╯\n')).toBeNull();
  });

  it('reads through the escape codes and cursor moves hc prints', () => {
    const coloured = [
      '\u001b[2J\u001b[H',
      '\u001b[1m Do you want to proceed?\u001b[0m',
      '\u001b[36m ❯ 1. Yes\u001b[0m',
      '\u001b[36m   2. No\u001b[0m',
      '',
    ].join('\r\n');
    expect(detectPrompt(coloured)).toEqual({
      prompt: 'Do you want to proceed?',
      choices: [
        { label: 'Allow', keys: ['enter'] },
        { label: "Don't allow", keys: ['down', 'enter'] },
      ],
    });
  });
});
