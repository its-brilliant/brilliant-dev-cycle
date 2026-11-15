import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from '../src/cli.js';
import { repoRoot } from './helpers.js';

const entry = fileURLToPath(new URL('../src/main.js', import.meta.url));
const root = repoRoot();

function run(args: string[], cwd = root): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('validate accepts the demo and rejects a cycle', () => {
  const ok = run(['validate', 'examples/demo']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'valid: examples/demo');
  assert.equal(ok.stderr, '');

  const bad = run(['validate', 'tests/fixtures/invalid/cycle']);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /tests\/fixtures\/invalid\/cycle\/\.herd\/phases\.yaml: phases: cycle detected: a -> b -> a/);
});

test('usage errors exit 2 and version prints the package version', () => {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  };
  try {
    assert.equal(main(['node', 'bdc', '--help']), 0);
    assert.equal(main(['node', 'bdc']), 0);
    assert.equal(main(['node', 'bdc', 'validate']), 2);
    assert.equal(main(['node', 'bdc', 'nope']), 2);
  } finally {
    console.log = log;
    console.error = error;
  }
  assert.match(logs[0] ?? '', /bdc validate <dir>/);
  assert.match(errors.join('\n'), /validate requires one directory/);
  assert.match(errors.join('\n'), /unknown command "nope"/);
  const version = run(['--version']);
  assert.equal(version.status, 0);
  assert.equal(version.stdout.trim(), '0.1.0');
  assert.equal(path.basename(entry), 'main.js');
});

test('validate through a symlinked directory fails for a missing path', () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bdc-symlink-'));
  const linked = path.join(tmp, 'linked-src');
  const missing = path.join(tmp, 'does-not-exist');
  try {
    symlinkSync(path.dirname(entry), linked);
    const result = spawnSync(process.execPath, [path.join(linked, 'main.js'), 'validate', missing], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /not a directory/);
    assert.doesNotMatch(result.stdout, /valid:/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
