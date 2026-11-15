import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parsePhasesYaml } from '../src/herd/phases.js';
import { initialRunState } from '../src/herd/state.js';
import { validateProject } from '../src/project.js';
import { lines, repoRoot } from './helpers.js';

const root = repoRoot();

test('the demo project is valid', () => {
  assert.deepEqual(lines(validateProject(path.join(root, 'examples/demo'))), []);
});

test('invalid fixtures report the field path', () => {
  const cases: Record<string, string[]> = {
    'bad-block-on': [
      'bdc.yaml: reviewers.security.block_on: expected one of any, low, medium, high, none, got "critical"',
    ],
    'verify-both': ['bdc.yaml: verify: set setup or setup_md, not both'],
    'github-target': [
      'bdc.yaml: pr_targets[0].project: unknown field',
      'bdc.yaml: pr_targets[0].repo: required for provider "github"',
    ],
    cycle: ['.herd/phases.yaml: phases: cycle detected: a -> b -> a'],
    'unknown-dep': ['.herd/phases.yaml: phases[0].deps[0]: unknown phase "missing"'],
    'check-both': ['.herd/phases.yaml: phases[0].verify.checks[0]: set exactly one of run or agent'],
    'bad-comment': [
      '.herd/comments/spec.v1.jsonl: id c2: parent_id "missing" does not match a comment',
    ],
  };
  for (const [name, expected] of Object.entries(cases)) {
    const issues = lines(validateProject(path.join(root, 'tests/fixtures/invalid', name)));
    assert.deepEqual(issues, expected, name);
  }
});

test('run directories stay gitignored', () => {
  for (const rel of [
    '.herd/runs/run1/state.json',
    'examples/demo/.herd/runs/run1/state.json',
    'tests/fixtures/invalid/cycle/.herd/runs/run1/state.json',
  ]) {
    execFileSync('git', ['check-ignore', '-q', '--', rel], { cwd: root });
  }
  assert.throws(() => {
    execFileSync('git', ['check-ignore', '-q', '--', 'examples/demo/.herd/phases.yaml'], { cwd: root });
  });
});

test('run state must match the phase DAG, and an override is accepted on the review', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bdc-run-'));
  cpSync(path.join(root, 'examples/demo'), dir, { recursive: true });
  const phases = parsePhasesYaml(readFileSync(path.join(dir, '.herd/phases.yaml'), 'utf8')).phases;
  assert.ok(phases);
  const runDir = path.join(dir, '.herd/runs/run1');
  mkdirSync(path.join(runDir, 'phases/model/evidence'), { recursive: true });
  writeFileSync(path.join(runDir, 'state.json'), `${JSON.stringify(initialRunState('run1', phases), null, 2)}\n`);
  writeFileSync(
    path.join(runDir, 'questions.jsonl'),
    `${JSON.stringify({ id: 'q1', prompt: 'Which columns?', status: 'pending', phase_id: 'model', task_id: 'schema' })}\n`,
  );
  writeFileSync(
    path.join(runDir, 'phases/model/review.json'),
    `${JSON.stringify({
      reviews: [{ reviewer: 'security', findings: [{ id: 'f1', severity: 'high', summary: 'check the log' }] }],
      overrides: [{ who: 'ada', reviewer: 'security', reason: 'The sample value is not a credential.' }],
    })}\n`,
  );
  assert.deepEqual(lines(validateProject(dir)), []);

  writeFileSync(
    path.join(runDir, 'phases/model/review.json'),
    `${JSON.stringify({
      reviews: [],
      overrides: [{ who: 'ada', reviewer: 'security' }],
    })}\n`,
  );
  assert.deepEqual(lines(validateProject(dir)), [
    `${path.relative(dir, path.join(runDir, 'phases/model/review.json')).split(path.sep).join('/')}: overrides[0].reason: required`,
  ]);
});

test('missing spec versions and a missing project directory are reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bdc-spec-'));
  cpSync(path.join(root, 'tests/fixtures/invalid/cycle'), dir, { recursive: true });
  writeFileSync(path.join(dir, '.herd/spec.v3.md'), '# Later\n');
  const issues = lines(validateProject(dir));
  assert.ok(issues.includes('.herd/spec.v2.md: file not found'));
  assert.deepEqual(lines(validateProject(path.join(dir, 'missing-dir'))), ['.: not a directory']);
});
