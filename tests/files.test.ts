import assert from 'node:assert/strict';
import test from 'node:test';
import { parseComments } from '../src/herd/comments.js';
import { parseQuestions } from '../src/herd/questions.js';
import { initialRunState, parseRunState } from '../src/herd/state.js';
import type { Phase } from '../src/herd/types.js';
import { lines } from './helpers.js';

const phases: Phase[] = [
  {
    id: 'model',
    title: 'Model',
    deps: [],
    tasks: [
      { id: 'schema', title: 'Schema' },
      { id: 'store', title: 'Store' },
    ],
  },
];

test('parses line comments and replies', () => {
  const parsed = parseComments(
    [
      '{"id":"c1","line":3,"author":"ada","body":"Why?","parent_id":null}',
      '{"id":"c2","line":3,"author":"spec","body":"Because.","parent_id":"c1","created_at":"2026-01-01T00:00:00Z"}',
      '',
    ].join('\n'),
    '.herd/comments/spec.v1.jsonl',
    { maxLine: 4, specFile: '.herd/spec.v1.md' },
  );
  assert.deepEqual(lines(parsed.issues), []);
  assert.equal(parsed.comments?.length, 2);
  assert.equal(parsed.comments?.[1]?.parent_id, 'c1');
});

test('reports comment failures with the jsonl line', () => {
  const parsed = parseComments(
    [
      '{"id":"c1","line":1,"author":"ada","body":"First"}',
      '{"id":"c1","line":1,"author":"ada","body":"Again"}',
      '{"id":"c2","line":9,"author":"ada","body":"Too far"}',
      '{',
    ].join('\n'),
    '.herd/comments/spec.v1.jsonl',
    { maxLine: 2, specFile: '.herd/spec.v1.md' },
  );
  assert.equal(parsed.issues.length, 3);
  assert.equal(lines(parsed.issues)[0], '.herd/comments/spec.v1.jsonl: line 2: duplicate comment id "c1"');
  assert.equal(
    lines(parsed.issues)[1],
    '.herd/comments/spec.v1.jsonl: line 3.line: comment line 9 is outside .herd/spec.v1.md (2 lines)',
  );
  assert.match(lines(parsed.issues)[2] ?? '', /^\.herd\/comments\/spec\.v1\.jsonl: line 4: invalid JSON \(/);
});

test('round-trips an initial run and rejects a phase that is in progress without a step', () => {
  const initial = initialRunState('run1', phases, 'build');
  const parsed = parseRunState(initial, '.herd/runs/run1/state.json');
  assert.deepEqual(lines(parsed.issues), []);
  assert.deepEqual(parsed.state, initial);

  const bad = parseRunState(
    {
      version: 1,
      run_id: 'run1',
      stage: 'build',
      phases: {
        model: { status: 'in_progress', tasks: { schema: { status: 'done' } } },
      },
    },
    '.herd/runs/run1/state.json',
  );
  assert.deepEqual(lines(bad.issues), [
    '.herd/runs/run1/state.json: phases.model.step: step is required when status is in_progress',
  ]);
});

test('requires verify_attempt while the step is verify', () => {
  const parsed = parseRunState(
    {
      version: 1,
      run_id: 'run1',
      stage: 'build',
      phases: {
        model: { status: 'in_progress', step: 'verify', tasks: {} },
      },
    },
    'state.json',
  );
  assert.deepEqual(lines(parsed.issues), [
    'state.json: phases.model.verify_attempt: verify_attempt is required when step is verify',
  ]);
});

test('parses pending and answered PM questions', () => {
  const ok = parseQuestions(
    [
      '{"id":"q1","prompt":"Which column?","status":"pending","phase_id":"model"}',
      '{"id":"q2","prompt":"Ship it?","status":"answered","answer":"Yes.","created_at":"2026-01-02T03:04:05Z"}',
    ].join('\n'),
    '.herd/runs/run1/questions.jsonl',
  );
  assert.deepEqual(lines(ok.issues), []);
  assert.equal(ok.questions?.[0]?.status, 'pending');
  assert.equal(ok.questions?.[1]?.answer, 'Yes.');

  const bad = parseQuestions(
    '{"id":"q1","prompt":"Stuck","status":"answered"}\n{"id":"q2","prompt":"No","status":"pending","answer":"too soon"}',
    'questions.jsonl',
  );
  assert.deepEqual(lines(bad.issues), [
    'questions.jsonl: line 1.answer: answer is required when status is answered',
    'questions.jsonl: line 2.answer: answer is only set when status is answered',
  ]);
});
