import assert from 'node:assert/strict';
import test from 'node:test';
import type { Severity, BlockOn } from '../src/config/types.js';
import { findingBlocks, parsePrEvidence, parseReviewerOverride, withReviewerOverride } from '../src/herd/evidence.js';
import { collectReviewerOverrides, parsePhaseReview } from '../src/herd/review.js';
import { lines } from './helpers.js';

test('findingBlocks follows the reviewer threshold', () => {
  const severities: Severity[] = ['low', 'medium', 'high'];
  const blocked = (threshold: BlockOn) => severities.filter((severity) => findingBlocks(severity, threshold));
  assert.deepEqual(blocked('any'), ['low', 'medium', 'high']);
  assert.deepEqual(blocked('low'), ['low', 'medium', 'high']);
  assert.deepEqual(blocked('medium'), ['medium', 'high']);
  assert.deepEqual(blocked('high'), ['high']);
  assert.deepEqual(blocked('none'), []);
});

test('models an operator override of a blocking reviewer', () => {
  const record = {
    who: 'ada',
    reviewer: 'security',
    reason: 'Accepted for the fixture data, tracked in the PR evidence.',
    at: '2026-01-01T00:00:00Z',
  };
  const parsed = parseReviewerOverride(record, 'evidence', 'reviewer_overrides[0]');
  assert.deepEqual(lines(parsed.issues), []);
  assert.deepEqual(parsed.override, record);

  const missing = parseReviewerOverride({ who: 'ada', reviewer: 'security' }, 'evidence', 'reviewer_overrides[0]');
  assert.deepEqual(lines(missing.issues), ['evidence: reviewer_overrides[0].reason: required']);

  const evidence = parsePrEvidence({
    spec_ref: '.herd/spec.v1.md',
    phase_ids: ['model'],
    reviewer_overrides: [],
    verify_logs: ['verify.log'],
    artifacts: ['junit.xml'],
  });
  assert.ok(evidence.evidence);
  const appended = withReviewerOverride(evidence.evidence, record);
  assert.deepEqual(lines(appended.issues), []);
  assert.deepEqual(appended.evidence.reviewer_overrides, [record]);
  const rejected = withReviewerOverride(evidence.evidence, { who: 'ada' });
  assert.equal(rejected.evidence.reviewer_overrides.length, 0);
  assert.ok(rejected.issues.length > 0);
});

test('collects overrides from a phase review file', () => {
  const parsed = parsePhaseReview(
    {
      reviews: [
        {
          reviewer: 'security',
          findings: [{ id: 'f1', severity: 'high', summary: 'secret in a log', location: 'src/cli.ts' }],
        },
      ],
      overrides: [{ who: 'ada', reviewer: 'security', reason: 'Rotated after the run.' }],
    },
    '.herd/runs/run1/phases/model/review.json',
  );
  assert.deepEqual(lines(parsed.issues), []);
  assert.deepEqual(collectReviewerOverrides(parsed.review ? [parsed.review] : []), [
    { who: 'ada', reviewer: 'security', reason: 'Rotated after the run.' },
  ]);
});
