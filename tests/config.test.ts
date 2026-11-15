import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { parseBdcYaml } from '../src/config/parse.js';
import { lines, repoRoot } from './helpers.js';

const SPEC_SAMPLE = `
agents:
  default: claude
  roles:
    spec: claude
    planner: claude
    worker: codex
    pm: claude
    reviewer: opencode
  custom:
    my-agent: { command: "my-agent --yolo", herdr_manifest: null }
concurrency: 4
max_envs: 4
max_attempts: 3
reviewers:
  security: { block_on: high }
  perf:     { block_on: high }
  ux:       { block_on: none }
keep_envs: false
pr_targets:
  - { provider: github, repo: org/app, base: main, draft: true }
  - { provider: gitlab, project: group/app, base: main }
`;

test('parses the spec sample', () => {
  const parsed = parseBdcYaml(SPEC_SAMPLE);
  assert.deepEqual(lines(parsed.issues), []);
  assert.deepEqual(parsed.config, {
    agents: {
      default: 'claude',
      roles: {
        spec: 'claude',
        planner: 'claude',
        worker: 'codex',
        pm: 'claude',
        reviewer: 'opencode',
      },
      custom: {
        'my-agent': { command: 'my-agent --yolo', herdr_manifest: null },
      },
    },
    concurrency: 4,
    max_envs: 4,
    max_attempts: 3,
    reviewers: {
      security: { block_on: 'high' },
      perf: { block_on: 'high' },
      ux: { block_on: 'none' },
    },
    keep_envs: false,
    pr_targets: [
      { provider: 'github', repo: 'org/app', base: 'main', draft: true },
      { provider: 'gitlab', project: 'group/app', base: 'main', draft: false },
    ],
  });
});

test('parses the demo config including env, verify, and an inline command', () => {
  const text = readFileSync(path.join(repoRoot(), 'examples/demo/bdc.yaml'), 'utf8');
  const parsed = parseBdcYaml(text);
  assert.deepEqual(lines(parsed.issues), []);
  assert.equal(parsed.config?.concurrency, 4);
  assert.deepEqual(parsed.config?.agents.roles.docs, {
    command: 'my-agent --yolo',
    herdr_manifest: null,
  });
  assert.equal(parsed.config?.env?.down, './scripts/env-down.sh ${PHASE_ID}');
  assert.equal(parsed.config?.verify?.checks[1]?.kind, 'agent');
  assert.deepEqual(parsed.reviewerNames, ['security', 'perf', 'ux']);
});

test('rejects a bad block_on with the field path', () => {
  const parsed = parseBdcYaml(`
agents: { default: claude, roles: { spec: claude, planner: claude, worker: codex, pm: claude, reviewer: opencode } }
concurrency: 1
max_envs: 1
max_attempts: 1
reviewers: { security: { block_on: critical } }
keep_envs: false
pr_targets: []
`);
  assert.deepEqual(lines(parsed.issues), [
    'bdc.yaml: reviewers.security.block_on: expected one of any, low, medium, high, none, got "critical"',
  ]);
});

test('requires provider-specific PR target fields', () => {
  const parsed = parseBdcYaml(`
agents: { default: claude, roles: { spec: claude, planner: claude, worker: codex, pm: claude, reviewer: opencode } }
concurrency: 1
max_envs: 1
max_attempts: 1
reviewers: {}
keep_envs: false
pr_targets:
  - { provider: gitlab, repo: group/app, base: main }
`);
  assert.deepEqual(lines(parsed.issues), [
    'bdc.yaml: pr_targets[0].repo: unknown field',
    'bdc.yaml: pr_targets[0].project: required for provider "gitlab"',
  ]);
});

test('rejects setup together with setup_md and a check that sets neither command', () => {
  const parsed = parseBdcYaml(`
agents: { default: claude, roles: { spec: claude, planner: claude, worker: codex, pm: claude, reviewer: opencode } }
concurrency: 1
max_envs: 1
max_attempts: 1
reviewers: {}
keep_envs: false
pr_targets: []
verify:
  setup: ./setup.sh
  setup_md: docs/verify.md
  checks:
    - {}
`);
  assert.deepEqual(lines(parsed.issues), [
    'bdc.yaml: verify: set setup or setup_md, not both',
    'bdc.yaml: verify.checks[0]: set exactly one of run or agent',
  ]);
});

test('rejects limits that are not positive integers and a missing role', () => {
  const parsed = parseBdcYaml(`
agents:
  default: claude
  roles:
    spec: claude
    planner: claude
    worker: { command: "", herdr_manifest: null }
    reviewer: opencode
concurrency: 0
max_envs: 1.5
max_attempts: 1
reviewers: {}
keep_envs: "false"
pr_targets: []
env: { up: ./up.sh }
`);
  assert.deepEqual(lines(parsed.issues), [
    'bdc.yaml: agents.roles.worker.command: expected a non-empty string, got ""',
    'bdc.yaml: agents.roles.pm: required',
    'bdc.yaml: concurrency: expected an integer >= 1, got 0',
    'bdc.yaml: max_envs: expected an integer >= 1, got 1.5',
    'bdc.yaml: keep_envs: expected a boolean, got "false"',
    'bdc.yaml: env.down: required',
  ]);
});

test('reports YAML syntax with a line path', () => {
  const parsed = parseBdcYaml('agents: [\n');
  assert.equal(parsed.issues.length, 1);
  assert.equal(parsed.issues[0]?.file, 'bdc.yaml');
  assert.match(parsed.issues[0]?.path ?? '', /^line \d+$/);
  assert.match(parsed.issues[0]?.message ?? '', /./);
});
