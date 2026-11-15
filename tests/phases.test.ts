import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parsePhasesYaml } from '../src/herd/phases.js';
import { UNIMPLEMENTED_PHASES } from '../src/later.js';
import { lines, repoRoot } from './helpers.js';

test('loads the dogfood plan and records later phases as TODOs', () => {
  const text = readFileSync(path.join(repoRoot(), 'docs/phases.yaml'), 'utf8');
  const parsed = parsePhasesYaml(text, 'docs/phases.yaml');
  assert.deepEqual(lines(parsed.issues), []);
  const ids = parsed.phases?.map((phase) => phase.id) ?? [];
  assert.deepEqual(ids[0], 'p1-core');
  assert.deepEqual(
    UNIMPLEMENTED_PHASES.map((phase) => phase.id),
    ids.filter((id) => id !== 'p1-core'),
  );
  assert.equal(parsed.phases?.[0]?.tasks[0]?.id, 't1');
  assert.match(parsed.phases?.[0]?.tasks[0]?.title ?? '', /Repo scaffold/);
});

test('loads the demo DAG', () => {
  const text = readFileSync(path.join(repoRoot(), 'examples/demo/.herd/phases.yaml'), 'utf8');
  const parsed = parsePhasesYaml(text);
  assert.deepEqual(lines(parsed.issues), []);
  assert.deepEqual(
    parsed.phases?.map((phase) => [phase.id, phase.deps]),
    [
      ['model', []],
      ['api', ['model']],
      ['ui', ['model']],
      ['ship', ['api', 'ui']],
    ],
  );
  assert.equal(parsed.phases?.[1]?.verify?.setup_md, 'docs/verify.md');
  assert.equal(parsed.phases?.[2]?.tasks[0]?.id, 'button');
});

test('reports a cycle and an unknown dependency', () => {
  const parsed = parsePhasesYaml(`
phases:
  - id: a
    title: A
    deps: [b, missing]
    tasks: ["one"]
  - id: b
    title: B
    deps: [a, a]
    tasks: ["two"]
`);
  assert.deepEqual(lines(parsed.issues), [
    '.herd/phases.yaml: phases[1].deps[1]: duplicate dependency "a"',
    '.herd/phases.yaml: phases[0].deps[1]: unknown phase "missing"',
    '.herd/phases.yaml: phases: cycle detected: a -> b -> a',
  ]);
});

test('reports a self-cycle and a duplicate phase id', () => {
  const parsed = parsePhasesYaml(`
phases:
  - id: a
    title: A
    deps: [a]
    tasks: ["one"]
  - id: a
    title: Again
    deps: []
    tasks: ["two"]
`);
  assert.deepEqual(lines(parsed.issues), [
    '.herd/phases.yaml: phases[1].id: duplicate phase id "a"',
    '.herd/phases.yaml: phases: cycle detected: a -> a',
  ]);
});

test('canonicalizes a cycle found from the later phase', () => {
  const parsed = parsePhasesYaml(`
phases:
  - id: c
    title: C
    deps: [a]
    tasks: ["c"]
  - id: b
    title: B
    deps: [c]
    tasks: ["b"]
  - id: a
    title: A
    deps: [b]
    tasks: ["a"]
`);
  assert.deepEqual(lines(parsed.issues), [
    '.herd/phases.yaml: phases: cycle detected: a -> b -> c -> a',
  ]);
});
