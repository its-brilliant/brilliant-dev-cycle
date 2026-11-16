import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { AgentObservation } from '../../src/contracts/events.js';
import { observationsFromHcEvents } from '../../src/hc/observations.js';

const fixtureLines = (name: string): string[] =>
  readFileSync(new URL(`../fixtures/hc-events/${name}`, import.meta.url), 'utf8').split('\n');

const statuses = (pairs: Array<[app: string, state: string]>): AgentObservation[] =>
  pairs.map(([app, state]) => ({ type: 'OBS_STATUS', app, state }));

/** Recorded real hc logs (tests/fixtures/hc-events/README.md), one row per file. */
const fixtures: Array<{ file: string; terminal: string; expected: AgentObservation[] }> = [
  {
    file: 'claude-spec-done.jsonl',
    terminal: 't6t',
    expected: statuses([
      ['bdc', 'working'],
      ['claude-code', 'idle'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'done'],
    ]),
  },
  {
    file: 'claude-planner-done.jsonl',
    terminal: 't6w',
    expected: statuses([
      ['bdc', 'working'],
      ['claude-code', 'idle'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'done'],
    ]),
  },
  {
    file: 'claude-reviewer-done.jsonl',
    terminal: 't75',
    expected: statuses([
      ['bdc', 'working'],
      ['claude-code', 'idle'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'done'],
    ]),
  },
  {
    file: 'claude-pm-killed-mid-turn.jsonl',
    terminal: 't79',
    expected: statuses([
      ['bdc', 'working'],
      ['claude-code', 'idle'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'working'],
      ['claude-code', 'done'],
    ]),
  },
  {
    // The startup idle right after the `bdc` launch marker: it says nothing about the agent.
    file: 'pi-builder-done.jsonl',
    terminal: 't72',
    expected: statuses([
      ['bdc', 'working'],
      ['pi', 'idle'],
      ['pi', 'working'],
      ['pi', 'done'],
    ]),
  },
];

describe('observationsFromHcEvents', () => {
  it.each(fixtures)('reads $file as the statuses it reports', ({ file, terminal, expected }) => {
    expect(observationsFromHcEvents(fixtureLines(file), terminal)).toEqual(expected);
  });

  it.each(fixtures)('ignores $file when asked about another terminal', ({ file }) => {
    expect(observationsFromHcEvents(fixtureLines(file), 't-other')).toEqual([]);
  });

  it('turns a finished terminal into OBS_EXITED with its exit code', () => {
    const line = (data: unknown): string =>
      JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { terminal: 't1', type: 'finished', data } });
    const lines = [line({ exit_code: 0, reason: 'exited', signal: null }), line({ exit_code: null, reason: 'killed', signal: 'SIGKILL' })];
    expect(observationsFromHcEvents(lines, 't1')).toEqual([
      { type: 'OBS_EXITED', code: 0 },
      { type: 'OBS_EXITED', code: null },
    ]);
  });

  it('skips unparseable lines, other event types and statuses without an app or state', () => {
    const lines = [
      '',
      'not json',
      '{"jsonrpc":"2.0","method":"event","params":{"terminal":"t1","type":"title","data":{"title":"x"}}}',
      '{"jsonrpc":"2.0","method":"event","params":{"terminal":"t1","type":"turn","data":{"state":"done","turn":2}}}',
      '{"jsonrpc":"2.0","method":"event","params":{"terminal":"t1","type":"status","data":{"status":{"state":"idle"}}}}',
      '{"jsonrpc":"2.0","method":"event","params":{"type":"status","data":{"status":{"app":"pi","state":"idle"}}}}',
      '{"jsonrpc":"2.0","method":"event","params":{"terminal":"t2","type":"status","data":{"status":{"app":"pi","state":"working"}}}}',
      '{"jsonrpc":"2.0","method":"event","params":{"terminal":"t1","type":"status","data":{"status":{"app":"pi","state":"working"}}}}',
    ];
    expect(observationsFromHcEvents(lines, 't1')).toEqual([{ type: 'OBS_STATUS', app: 'pi', state: 'working' }]);
  });
});
