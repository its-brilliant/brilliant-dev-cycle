/**
 * Lens prompts (spec §8): which prompt a lens runs with, where each one lives, and the four
 * Reviewers-screen actions that move a prompt between the shared home and the project.
 * Every test points `BDC_HOME` at a temp dir, so the person's real `~/.config/bdc` is never read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertLensName,
  bdcHome,
  defaultPrompt,
  lensPrompts,
  localizeLens,
  projectLensFile,
  resolveLens,
  shareLens,
  sharedLensFile,
  writeLens,
} from '../../src/herd/lenses.js';

let root: string;
let home: string;
let env: Record<string, string | undefined>;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-lenses-root-'));
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-lenses-home-'));
  env = { BDC_HOME: home };
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe('where prompts live', () => {
  it('uses BDC_HOME, or ~/.config/bdc when it is not set', () => {
    expect(bdcHome(env)).toBe(home);
    expect(bdcHome({})).toBe(path.join(os.homedir(), '.config', 'bdc'));
    expect(bdcHome({ BDC_HOME: '  ' })).toBe(path.join(os.homedir(), '.config', 'bdc'));
  });

  it('puts shared prompts under the bdc home and project copies under .herd', () => {
    expect(sharedLensFile('security', env)).toBe(path.join(home, 'reviewers', 'security.md'));
    expect(projectLensFile(root, 'security')).toBe(path.join(root, '.herd', 'reviewers', 'security.md'));
  });
});

describe('resolveLens', () => {
  it('falls back to the built-in prompt when nobody wrote one', () => {
    const lens = resolveLens(root, 'security', env);

    expect(lens).toEqual({ name: 'security', text: defaultPrompt('security'), source: 'default' });
    expect(lens.text).toContain('security problems');
  });

  it('prefers the shared prompt, then the project copy over it', () => {
    writeLens(root, 'security', 'Shared: look for leaked keys.', 'shared', env);
    expect(resolveLens(root, 'security', env)).toMatchObject({ source: 'shared', text: 'Shared: look for leaked keys.\n' });

    writeLens(root, 'security', 'Project: look for our own session bug.', 'project', env);
    expect(resolveLens(root, 'security', env)).toMatchObject({
      source: 'project',
      text: 'Project: look for our own session bug.\n',
    });
  });

  it('has a named default for any lens, not only the built-in ones', () => {
    const lens = resolveLens(root, 'a11y', env);

    expect(lens.source).toBe('default');
    expect(lens.text).toContain('"a11y" lens');
    expect(defaultPrompt('perf')).toContain('performance problems');
    expect(defaultPrompt('ux')).toContain('how it feels to use');
  });

  it('treats a blank prompt file as no prompt at all', () => {
    writeLens(root, 'perf', '   ', 'shared', env);

    expect(resolveLens(root, 'perf', env).source).toBe('default');
  });

  it('refuses a name that is not a lens name', () => {
    expect(() => resolveLens(root, 'Security', env)).toThrow(/not a lens name/);
    expect(() => resolveLens(root, '../etc/passwd', env)).toThrow(/not a lens name/);
  });
});

describe('lensPrompts', () => {
  it('answers the prompt text of every lens the run has, which is what ProjectRuns hands the machine', () => {
    writeLens(root, 'perf', 'Only the hot path.', 'project', env);

    expect(lensPrompts(root, ['security', 'perf'], env)).toEqual({
      security: defaultPrompt('security'),
      perf: 'Only the hot path.\n',
    });
  });
});

describe('moving prompts between shared and project', () => {
  it('writes a prompt in either scope', () => {
    const shared = writeLens(root, 'ux', 'Look at the empty states.', 'shared', env);
    const project = writeLens(root, 'ux', 'Look at our empty states.', 'project', env);

    expect(fs.readFileSync(shared, 'utf8')).toBe('Look at the empty states.\n');
    expect(fs.readFileSync(project, 'utf8')).toBe('Look at our empty states.\n');
  });

  it('shares a project copy and removes the copy', () => {
    writeLens(root, 'ux', 'Look at our empty states.', 'project', env);

    const shared = shareLens(root, 'ux', env);

    expect(shared).toBe(sharedLensFile('ux', env));
    expect(fs.readFileSync(shared, 'utf8')).toBe('Look at our empty states.\n');
    expect(fs.existsSync(projectLensFile(root, 'ux'))).toBe(false);
    expect(resolveLens(root, 'ux', env).source).toBe('shared');
  });

  it('localizes a shared prompt into the project', () => {
    writeLens(root, 'perf', 'Only the hot path.', 'shared', env);

    const project = localizeLens(root, 'perf', env);

    expect(project).toBe(projectLensFile(root, 'perf'));
    expect(fs.readFileSync(project, 'utf8')).toBe('Only the hot path.\n');
    expect(resolveLens(root, 'perf', env).source).toBe('project');
  });

  it('says so when there is nothing to share or to copy', () => {
    expect(() => shareLens(root, 'perf', env)).toThrow(/no copy of the perf lens to share/);
    expect(() => localizeLens(root, 'perf', env)).toThrow(/no shared prompt for the perf lens to copy/);
  });
});

describe('assertLensName', () => {
  it('accepts the names bdc.yaml accepts', () => {
    for (const name of ['security', 'perf', 'ux', 'a11y', 'data-1', 'a'.repeat(40)]) {
      expect(assertLensName(name)).toBe(name);
    }
  });

  it('rejects anything else', () => {
    for (const name of ['', '-lead', 'Security', 'a b', 'a_b', 'a'.repeat(41)]) {
      expect(() => assertLensName(name)).toThrow(/not a lens name/);
    }
  });
});
