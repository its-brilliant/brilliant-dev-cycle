import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_ENV, agentDir, inboxFile, type InboxEntry } from '../../src/contracts/inbox.js';
import { envFromProcess, isSubmitKind, submit } from '../../src/agents/submit.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-submit-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const env = (kind: Parameters<typeof submit>[0]['kind'] = 'spec') => ({ root, run: 'run-1', key: 'run-1/spec/1', kind });

function inbox(dir: string): InboxEntry[] {
  return fs
    .readFileSync(inboxFile(dir), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as InboxEntry);
}

describe('submit', () => {
  it('appends an accepted submission to the job inbox, counting up from 1', () => {
    expect(submit(env(), { markdown: '# Spec' })).toEqual({ ok: true, seq: 1 });
    expect(submit(env(), { markdown: '# Spec v2', notes: ['addressed the auth comment'] })).toEqual({ ok: true, seq: 2 });

    const entries = inbox(agentDir(root, 'run-1', 'run-1/spec/1'));
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(entries[1]).toMatchObject({ kind: 'spec', submission: { markdown: '# Spec v2', notes: ['addressed the auth comment'] } });
    expect(Number.isNaN(Date.parse(entries[0]?.at ?? ''))).toBe(false);
  });

  it('rejects a submission that does not fit its kind, naming the field a model must fix', () => {
    const result = submit(env(), { markdown: '' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join('\n')).toMatch(/^markdown: /m);
    expect(fs.existsSync(inboxFile(agentDir(root, 'run-1', 'run-1/spec/1')))).toBe(false);
  });

  it('reports a payload that is not an object at all against the root', () => {
    const result = submit(env('findings'), { findings: [{ id: 'f1', severity: 'urgent', summary: 'x' }] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems.join('\n')).toMatch(/^findings\.0\.severity: /m);
  });

  it('keeps one entry per line when several writers append in a loop', () => {
    const writers = 25;
    for (let index = 0; index < writers; index += 1) submit(env(), { markdown: `# Spec ${index}` });
    const lines = fs.readFileSync(inboxFile(agentDir(root, 'run-1', 'run-1/spec/1')), 'utf8').split('\n');
    expect(lines.at(-1)).toBe('');
    expect(lines.filter((line) => line !== '')).toHaveLength(writers);
    expect(inbox(agentDir(root, 'run-1', 'run-1/spec/1')).map((entry) => entry.seq)).toEqual(
      Array.from({ length: writers }, (_, index) => index + 1),
    );
  });

  it('fills the schema defaults, so the inbox holds what the observer reads', () => {
    submit(env('brief'), { brief: 'Ship it' });
    const [entry] = inbox(agentDir(root, 'run-1', 'run-1/spec/1'));
    expect(entry?.submission).toEqual({ brief: 'Ship it', decisions: [], assumptions: [] });
  });
});

describe('envFromProcess', () => {
  const saved = { ...process.env };

  afterEach(() => {
    process.env = { ...saved };
  });

  it('reads the job from the AGENT_ENV variables bdc starts the agent with', () => {
    process.env[AGENT_ENV.root] = root;
    process.env[AGENT_ENV.run] = 'run-7';
    process.env[AGENT_ENV.key] = 'run-7/p2/t1/builder';
    process.env[AGENT_ENV.submit] = 'task';
    expect(envFromProcess()).toEqual({ root, run: 'run-7', key: 'run-7/p2/t1/builder', kind: 'task' });
  });

  it('names the missing variable when it is not inside a job', () => {
    delete process.env[AGENT_ENV.key];
    expect(() => envFromProcess()).toThrow(new RegExp(AGENT_ENV.key));
  });

  it('refuses a BDC_SUBMIT that is not a submission kind', () => {
    process.env[AGENT_ENV.root] = root;
    process.env[AGENT_ENV.run] = 'run-7';
    process.env[AGENT_ENV.key] = 'run-7/pm/1';
    process.env[AGENT_ENV.submit] = 'review';
    expect(() => envFromProcess()).toThrow(/not a bdc submission kind/);
    expect(isSubmitKind('review')).toBe(false);
    expect(isSubmitKind('findings')).toBe(true);
  });
});
