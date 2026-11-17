import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main, type CliIO } from '../../src/cli/main.js';
import { AGENT_ENV, agentDir, inboxFile, type InboxEntry } from '../../src/contracts/inbox.js';

let root: string;
const saved = { ...process.env };

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-submit-cli-'));
  process.env[AGENT_ENV.root] = root;
  process.env[AGENT_ENV.run] = 'run-1';
  process.env[AGENT_ENV.key] = 'run-1/spec/1';
  process.env[AGENT_ENV.submit] = 'spec';
});

afterEach(() => {
  process.env = { ...saved };
  fs.rmSync(root, { recursive: true, force: true });
});

/** Collects what the command wrote, the way `bin.ts` would print it. */
function captureIO(): { io: CliIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (text) => out.push(text), err: (text) => err.push(text) }, out, err };
}

function inbox(): InboxEntry[] {
  const file = inboxFile(agentDir(root, 'run-1', 'run-1/spec/1'));
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as InboxEntry);
}

describe('bdc submit', () => {
  it('takes the submission as a JSON argument and prints its seq', async () => {
    const { io, out } = captureIO();
    expect(await main(['submit', 'spec', '{"markdown":"# Spec"}'], io)).toBe(0);
    expect(out).toEqual(['submitted #1\n']);
    expect(inbox()).toMatchObject([{ seq: 1, kind: 'spec', submission: { markdown: '# Spec', notes: [] } }]);
  });

  it('takes the submission from --file', async () => {
    const file = path.join(root, 'spec.json');
    fs.writeFileSync(file, JSON.stringify({ markdown: '# Spec from a file' }));
    const { io, out } = captureIO();
    expect(await main(['submit', 'spec', '--file', file], io)).toBe(0);
    expect(out).toEqual(['submitted #1\n']);
    expect(inbox()[0]?.submission).toMatchObject({ markdown: '# Spec from a file' });
  });

  it('answers a rejected submission with the problems and exit 1', async () => {
    const { io, out, err } = captureIO();
    expect(await main(['submit', 'spec', '{"markdown":""}'], io)).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('')).toMatch(/markdown: /);
    expect(inbox()).toEqual([]);
  });

  it('answers a payload that is not JSON with exit 1', async () => {
    const { io, err } = captureIO();
    expect(await main(['submit', 'spec', 'not json'], io)).toBe(1);
    expect(err.join('')).toMatch(/not JSON/);
  });

  it('refuses a kind that is not the job\'s own', async () => {
    const { io, err } = captureIO();
    expect(await main(['submit', 'plan', '{"phases":[]}'], io)).toBe(1);
    expect(err.join('')).toMatch(/this job submits spec, not plan/);
    expect(inbox()).toEqual([]);
  });

  it('answers an unknown kind with the usage and exit 2', async () => {
    const { io, err } = captureIO();
    expect(await main(['submit', 'review', '{}'], io)).toBe(2);
    expect(err.join('')).toMatch(/submit does not know the kind "review"/);
  });

  it('says which AGENT_ENV variable is missing outside a job', async () => {
    delete process.env[AGENT_ENV.key];
    const { io, err } = captureIO();
    expect(await main(['submit', 'spec', '{"markdown":"# Spec"}'], io)).toBe(1);
    expect(err.join('')).toContain(AGENT_ENV.key);
  });
});
