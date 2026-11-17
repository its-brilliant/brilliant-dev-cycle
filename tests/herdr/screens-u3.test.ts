/**
 * The four run screens' facts (spec §4.4, §4.6, §8.1): the Build board's step tracks and
 * dependency order, the phase screen's tasks, review, verification and proof, the Reviews filters,
 * and the Ship preview. The screens themselves are GPUI; everything they decide is in the plain
 * JavaScript helpers these tests import, driven by one `RunView` fixture that covers every phase
 * state and every finding status (tests never load Herdr).
 *
 * The helpers are part of a Herdr mod, so they import the mod's own copy of the kit
 * (`../kit/words.js`), which `bdc herdr install` puts inside the mod folder. This test stages the
 * mod the way install does — the real screens beside the real kit — and imports it from there, so
 * what it checks is the files that ship (the same staging tests/herdr/install.test.ts uses).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { FindingView, PhaseView, RunView } from '../../src/contracts/view.js';
import { RunView as RunViewSchema } from '../../src/contracts/view.js';
import type { FindingFilters } from '../../herdr-app/mods/bdc-main/screens/reviews-filters.js';

const REPO = fileURLToPath(new URL('../../', import.meta.url));

/** The mod as `bdc herdr install` lays it out: its screens and the kit they import, together. */
function stageMod(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-screens-u3-'));
  const mod = path.join(home, 'mods', 'bdc-main');
  fs.cpSync(path.join(REPO, 'herdr-app', 'mods', 'bdc-main', 'screens'), path.join(mod, 'screens'), { recursive: true });
  fs.cpSync(path.join(REPO, 'herdr-app', 'kit'), path.join(mod, 'kit'), { recursive: true });
  return mod;
}

const STAGED = stageMod();

afterAll(() => {
  fs.rmSync(path.dirname(path.dirname(STAGED)), { recursive: true, force: true });
});

/** One staged helper module, typed by the declaration file that sits next to its source. */
async function load<T>(file: string): Promise<T> {
  return (await import(pathToFileURL(path.join(STAGED, 'screens', file)).href)) as T;
}

const board = await load<typeof import('../../herdr-app/mods/bdc-main/screens/build-board.js')>('build-board.js');
const detail = await load<typeof import('../../herdr-app/mods/bdc-main/screens/phase-detail.js')>('phase-detail.js');
const reviews = await load<typeof import('../../herdr-app/mods/bdc-main/screens/reviews-filters.js')>('reviews-filters.js');
const ship = await load<typeof import('../../herdr-app/mods/bdc-main/screens/ship-preview.js')>('ship-preview.js');

const { PHASE_STEPS, attemptsWords, checksWords, findingsByStatus, findingsWords, needsYouWords, phaseTone, phaseWaves, phasesDone, stepPosition, stepTrack } = board;
const { blockingLenses, byWords, decisionsAbout, depsWords, durationWords, findingNote, imageFile, proofRows, reviewByLens, tasksOf, verificationRows, verificationWords } = detail;
const { FINDING_STATUSES, SEVERITIES, allFindings, blocksNow, countWords, detailRows, fileLine, filterFindings, filterValues, severityTone, statusTone, statusWords } = reviews;
const { TITLE_LIMIT, phaseBadge, previewSections, pullRequestTitle, whereItWent } = ship;

/** Every phase state the projection can produce (src/runtime/project.ts, spec §5.3). */
const PHASE_STATES = [
  'waiting',
  'building',
  'merging',
  'resolving',
  'reviewing',
  'queuedForVerify',
  'verifying',
  'proving',
  'deciding',
  'awaitingYou',
  'fixing',
  'continuing',
  'passed',
  'done',
  'stopped',
  'cancelled',
];

const ROOT = '/work/app';

function finding(id: string, lens: string, status: FindingView['status'], overrides: Partial<FindingView> = {}): FindingView {
  return { id, severity: 'high', summary: `The ${id} problem`, lens, status, note: '', ...overrides };
}

function phase(id: string, title: string, state: string, overrides: Partial<PhaseView> = {}): PhaseView {
  return { id, title, deps: [], state, words: `${state} words`, needsYou: false, attemptsUsed: 1, findings: [], verification: null, proof: [], ...overrides };
}

const VERIFIED = {
  passed: true,
  steps: [
    { name: 'unit tests', command: 'npm test', exitCode: 0, durationMs: 11_000, outputTail: '12 passed' },
    { name: 'types', command: 'npm run typecheck', exitCode: 0, durationMs: 2_000, outputTail: '' },
  ],
};

const FAILED_VERIFY = {
  passed: false,
  steps: [
    { name: 'unit tests', command: 'npm test', exitCode: 1, durationMs: 65_000, outputTail: '1 failed' },
    { name: 'e2e', command: 'npm run e2e', exitCode: null, durationMs: 0, outputTail: '' },
  ],
};

/** One run view with every phase state, every finding status and proof of each kind (§4.4.1). */
const VIEW: RunView = {
  runId: 'r-u3',
  goal: 'Add a health check\nand say so on the dashboard',
  stage: 'building',
  stageWords: 'Building 2 of 17 phases',
  paused: false,
  needsYou: true,
  error: null,
  asking: null,
  agentPrompts: [],
  chat: [
    { from: 'pm', text: 'p3 is blocked on a question about the retry policy.' },
    { from: 'you', text: 'p3: keep one reminder, then wait.' },
    { from: 'pm', text: 'All the other phases keep running.' },
  ],
  proposals: [],
  brief: null,
  spec: null,
  plan: {
    phases: [
      {
        id: 'p1',
        title: 'Repo and config',
        deps: [],
        tasks: [{ id: 'p1-task', title: 'Write the config loader', paths: ['src/config.ts'] }],
        checks: [{ name: 'unit', run: 'npm test' }],
        proof: [{ kind: 'tests', shows: 'the checks pass' }],
      },
      {
        id: 'p3',
        title: 'Health endpoint',
        deps: ['p1'],
        tasks: [
          { id: 'p3-api', title: 'Serve the health endpoint', paths: ['src/health.ts'] },
          { id: 'p3-ui', title: 'Show it on the dashboard', paths: ['src/ui/dashboard.tsx'] },
        ],
        checks: [{ name: 'unit', run: 'npm test' }],
        proof: [{ kind: 'screenshot', shows: 'the dashboard with the health chip' }],
      },
      {
        id: 'p5',
        title: 'Docs',
        deps: ['p3'],
        tasks: [{ id: 'p5-docs', title: 'Document the endpoint', paths: ['docs/health.md'] }],
        checks: [{ name: 'unit', run: 'npm test' }],
        proof: [{ kind: 'log', shows: 'the docs build' }],
      },
    ],
  },
  phases: [
    phase('p1', 'Repo and config', 'done', {
      findings: [
        finding('SEC-1', 'security', 'fixed', { file: 'src/config.ts', line: 12, fix: 'parse it as JSON' }),
        finding('SEC-4', 'security', 'overridden', { note: 'you overrode it: the token is short lived' }),
        finding('UX-9', 'ux', 'advisory', { severity: 'low' }),
      ],
      verification: VERIFIED,
      proof: [
        { kind: 'tests', shows: 'the checks pass', file: 'phases/p1/proof/verify.json', by: 'bdc' },
        { kind: 'log', shows: 'the migration ran', file: 'phases/p1/proof/migrate.log', by: 'verifier' },
        { kind: 'manual', shows: 'you confirmed the config screen', by: 'person' },
      ],
    }),
    phase('p2', 'Runner', 'passed', { deps: ['p1'], verification: VERIFIED }),
    phase('p3', 'Health endpoint', 'awaitingYou', {
      deps: ['p1'],
      words: 'waiting on you',
      needsYou: true,
      attemptsUsed: 2,
      findings: [
        finding('PERF-1', 'perf', 'open', { severity: 'medium', file: 'src/health.ts', line: 88 }),
        finding('SEC-2', 'security', 'open', { severity: 'critical' }),
        finding('UX-1', 'ux', 'fixing', { severity: 'low' }),
      ],
      verification: FAILED_VERIFY,
      proof: [{ kind: 'screenshot', shows: 'the dashboard with the health chip', file: 'phases/p3/proof/dashboard.png', by: 'verifier' }],
    }),
    phase('p4', 'Background jobs', 'stopped', { deps: ['p1'], words: 'stopped' }),
    phase('p5', 'Docs', 'waiting', { deps: ['p3'], words: 'waiting for p3' }),
    phase('p6', 'Search', 'building', { words: 'building 2 tasks' }),
    phase('p7', 'Cache', 'merging', { words: 'merging the tasks' }),
    phase('p8', 'Import', 'resolving', { words: 'resolving a conflict' }),
    phase('p9', 'Export', 'reviewing', { words: 'in review', findings: [finding('PERF-2', 'perf', 'fixed', { severity: 'low' })] }),
    phase('p10', 'Alerts', 'queuedForVerify', { words: 'waiting for a verification slot' }),
    phase('p11', 'Metrics', 'verifying', { words: 'verifying' }),
    phase('p12', 'Reports', 'proving', { words: 'collecting proof' }),
    phase('p13', 'Billing', 'deciding', { words: 'waiting for the PM', findings: [finding('SEC-3', 'security', 'continued', { note: 'the PM carried on: not reachable from the UI' })] }),
    phase('p14', 'Invites', 'fixing', { words: 'fixing', findings: [finding('UX-2', 'ux', 'fixing', { severity: 'medium' })] }),
    phase('p15', 'Onboarding', 'continuing', { words: 'carrying on' }),
    phase('p17', 'Archive', 'cancelled', { words: 'stopped' }),
  ],
  finalFindings: [
    finding('SEC-7', 'security', 'open', { severity: 'high', summary: 'The sync token lands in state.json', file: 'src/sync/session.ts', line: 44 }),
    finding('DOC-1', 'docs', 'advisory', { severity: 'low', summary: 'The README misses the new flag' }),
  ],
  pullRequest: null,
};

/** One phase of the fixture by its state, so a test reads as the state it is about. */
function phaseIn(state: string): PhaseView {
  const found = VIEW.phases.find((candidate) => candidate.state === state);
  if (found === undefined) throw new Error(`the fixture has no phase in state ${state}`);
  return found;
}

describe('the run view fixture', () => {
  it('is a real RunView and covers every phase state and finding status', () => {
    expect(RunViewSchema.safeParse(VIEW).success).toBe(true);
    expect(VIEW.phases.map((candidate) => candidate.state).sort()).toEqual([...PHASE_STATES].sort());
    const statuses = new Set([...VIEW.phases.flatMap((candidate) => candidate.findings), ...VIEW.finalFindings].map((candidate) => candidate.status));
    expect([...statuses].sort()).toEqual([...FINDING_STATUSES].sort());
    expect(VIEW.phases.flatMap((candidate) => candidate.proof).map((item) => item.by)).toEqual(expect.arrayContaining(['bdc', 'verifier', 'person']));
  });
});

describe("the Build board's step track", () => {
  it('gives every phase five steps, in order', () => {
    for (const candidate of VIEW.phases) {
      expect(stepTrack(candidate).map((step) => step.name)).toEqual(PHASE_STEPS);
    }
  });

  it('reads where each known state sits on the track', () => {
    const statuses = (state: string): string[] => stepTrack(phaseIn(state)).map((step) => step.status);
    expect(statuses('waiting')).toEqual(['waiting', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(statuses('building')).toEqual(['active', 'waiting', 'waiting', 'waiting', 'waiting']);
    expect(statuses('merging')).toEqual(['done', 'active', 'waiting', 'waiting', 'waiting']);
    expect(statuses('resolving')).toEqual(['done', 'active', 'waiting', 'waiting', 'waiting']);
    expect(statuses('reviewing')).toEqual(['done', 'done', 'active', 'waiting', 'waiting']);
    expect(statuses('queuedForVerify')).toEqual(['done', 'done', 'done', 'queued', 'waiting']);
    expect(statuses('verifying')).toEqual(['done', 'done', 'done', 'active', 'waiting']);
    expect(statuses('proving')).toEqual(['done', 'done', 'done', 'done', 'active']);
    expect(statuses('passed')).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect(statuses('done')).toEqual(['done', 'done', 'done', 'done', 'done']);
  });

  it('reads a waiting-on-you phase from what it has already produced', () => {
    // p3 got through review and verify, and its verify failed: it is deciding about verify.
    expect(stepPosition(phaseIn('awaitingYou'))).toEqual({ done: 3, active: 3, queued: false });
    // p14 is fixing a finding, so it is back in review.
    expect(stepPosition(phaseIn('fixing'))).toEqual({ done: 2, active: 2, queued: false });
    // p13 waits on the PM with a continued finding and no verification: review.
    expect(stepPosition(phaseIn('deciding'))).toEqual({ done: 2, active: 2, queued: false });
    // p15 and p4 have produced nothing yet, so nothing is claimed for them.
    expect(stepPosition(phaseIn('continuing'))).toEqual({ done: 0, active: 0, queued: false });
    expect(stepPosition(phaseIn('stopped'))).toEqual({ done: 0, active: 0, queued: false });
  });

  it('counts a phase as done only once it has merged into the run', () => {
    expect(phasesDone(VIEW.phases)).toEqual({ done: 1, total: 16, words: '1 of 16 phases done' });
    expect(phasesDone([phase('p1', 'One', 'done')])).toEqual({ done: 1, total: 1, words: '1 of 1 phase done' });
    expect(phasesDone([])).toEqual({ done: 0, total: 0, words: '0 of 0 phases done' });
  });
});

describe("the Build board's dependency order", () => {
  it('puts a phase in a later wave than the phases it waits for', () => {
    const waves = phaseWaves(VIEW.phases);
    const place = new Map<string, number>();
    waves.forEach((wave, index) => wave.forEach((candidate) => place.set(candidate.id, index)));
    for (const candidate of VIEW.phases) {
      for (const dep of candidate.deps) expect(place.get(candidate.id)).toBeGreaterThan(place.get(dep) ?? -1);
    }
    expect(waves[0]?.map((candidate) => candidate.id)).toEqual(expect.arrayContaining(['p1', 'p6']));
    expect(waves[0]?.map((candidate) => candidate.id)).not.toContain('p2');
  });

  it('keeps every phase, including one whose dependency the plan does not have', () => {
    const orphan = phase('p9', 'Orphan', 'waiting', { deps: ['nope'] });
    const waves = phaseWaves([phase('p1', 'One', 'done'), orphan]);
    // A dependency the plan does not have cannot be waited for, so it does not hold the phase back.
    expect(waves).toHaveLength(1);
    expect(waves[0]?.map((candidate) => candidate.id)).toEqual(['p1', 'p9']);
  });
});

describe("the Build board's facts", () => {
  it('counts findings by what happened to them and says them in words', () => {
    expect(findingsByStatus(phaseIn('awaitingYou').findings)).toEqual({ open: 2, fixing: 1, fixed: 0, continued: 0, overridden: 0, advisory: 0 });
    expect(findingsWords(phaseIn('awaitingYou').findings)).toBe('2 open · 1 being fixed');
    expect(findingsWords([])).toBe('');
  });

  it('says how many checks pass, and nothing before a phase is verified', () => {
    expect(checksWords(phaseIn('done'))).toBe('2 of 2 checks pass');
    expect(checksWords(phaseIn('awaitingYou'))).toBe('0 of 2 checks pass');
    expect(checksWords(phaseIn('waiting'))).toBe('');
  });

  it('mentions attempts only once a phase needed more than one', () => {
    expect(attemptsWords(phaseIn('awaitingYou'))).toBe('2 attempts used');
    expect(attemptsWords(phaseIn('waiting'))).toBe('');
  });

  it('points at PM chat for the phases that need the person', () => {
    expect(needsYouWords(VIEW.phases)).toBe('The PM is asking you about p3 — see PM chat.');
    expect(needsYouWords([phase('p1', 'One', 'done')])).toBe('');
    expect(needsYouWords([phase('p1', 'One', 'awaitingYou', { needsYou: true }), phase('p2', 'Two', 'awaitingYou', { needsYou: true })])).toBe(
      'The PM is asking you about p1 and p2 — see PM chat.',
    );
  });

  it('colors a card by what needs the person, what passed and what is running', () => {
    expect(phaseTone(phaseIn('awaitingYou'))).toBe('blocked');
    expect(phaseTone(phaseIn('done'))).toBe('pass');
    expect(phaseTone(phaseIn('waiting'))).toBe('dim');
    expect(phaseTone(phaseIn('stopped'))).toBe('dim');
    expect(phaseTone(phaseIn('building'))).toBe('working');
  });
});

describe("the phase screen's facts", () => {
  it("takes a phase's tasks from the plan the run was approved with", () => {
    expect(tasksOf(VIEW, 'p3').map((task) => task.id)).toEqual(['p3-api', 'p3-ui']);
    expect(tasksOf(VIEW, 'p6')).toEqual([]);
  });

  it('says what a phase waits for and what it unlocks', () => {
    expect(depsWords(phaseIn('waiting'), VIEW.phases)).toBe('Needs p3');
    expect(depsWords(phase('p1', 'One', 'building'), VIEW.phases)).toBe('Starts first · unlocks p2, p3 and p4');
    expect(depsWords(phase('p9', 'Nine', 'building'), VIEW.phases)).toBe('Starts first');
  });

  it('groups the review by lens and marks the lens that still blocks', () => {
    const lenses = reviewByLens(phaseIn('awaitingYou'));
    expect(lenses.map((lens) => lens.lens).sort()).toEqual(['perf', 'security', 'ux']);
    expect(lenses.find((lens) => lens.lens === 'security')).toMatchObject({ words: '1 finding open', tone: 'blocked' });
    expect(lenses.find((lens) => lens.lens === 'ux')).toMatchObject({ words: '1 finding', tone: 'working' });
    expect(blockingLenses(phaseIn('awaitingYou')).sort()).toEqual(['perf', 'security']);
    expect(blockingLenses(phaseIn('done'))).toEqual([]);
    expect(reviewByLens(phaseIn('building'))).toEqual([]);
  });

  it('gives a finding its reason when it was continued or overridden', () => {
    expect(findingNote(finding('SEC-3', 'security', 'continued', { note: 'not reachable' }))).toBe('not reachable');
    expect(findingNote(finding('SEC-3', 'security', 'open'))).toBe('');
  });

  it('lists every verification step with its result, command and duration', () => {
    const rows = verificationRows(phaseIn('awaitingYou'));
    expect(rows.map((row) => [row.words, row.tone, row.duration])).toEqual([
      ['failed', 'blocked', '1m 05s'],
      ['not run', 'dim', ''],
    ]);
    expect(rows[0]).toMatchObject({ name: 'unit tests', command: 'npm test', outputTail: '1 failed' });
    expect(verificationRows(phaseIn('waiting'))).toEqual([]);
  });

  it('says a duration a person reads', () => {
    expect(durationWords(11_000)).toBe('11s');
    expect(durationWords(65_000)).toBe('1m 05s');
    expect(durationWords(120_000)).toBe('2m');
    expect(durationWords(0)).toBe('');
    expect(durationWords(Number.NaN)).toBe('');
  });

  it('summarizes the verification in words', () => {
    expect(verificationWords(phaseIn('done'))).toBe('2 of 2 checks passed · 13s');
    expect(verificationWords(phaseIn('awaitingYou'))).toBe('0 of 2 checks pass · 1m 05s');
    expect(verificationWords(phaseIn('waiting'))).toBe('Not verified yet.');
  });

  it('names who made each proof item and points a screenshot at its absolute file', () => {
    const rows = proofRows(VIEW, phaseIn('awaitingYou'), ROOT);
    expect(rows[0]).toMatchObject({ kind: 'screenshot', shows: 'the dashboard with the health chip', by: 'the verifier' });
    expect(rows[0]?.image).toBe('/work/app/.herd/runs/r-u3/phases/p3/proof/dashboard.png');
    expect(byWords('bdc')).toBe('bdc');
    expect(byWords('person')).toBe('you');
    expect(proofRows(VIEW, phaseIn('done'), ROOT).map((row) => row.by)).toEqual(['bdc', 'the verifier', 'you']);
    expect(proofRows(VIEW, phaseIn('done'), ROOT)[1]?.image).toBe('');
    expect(imageFile(VIEW, { kind: 'screenshot', shows: '', file: 'a.png', by: 'verifier' }, null)).toBe('');
  });

  it('finds what the PM said about this phase in the run chat', () => {
    expect(decisionsAbout(VIEW, phaseIn('awaitingYou')).map((entry) => entry.text)).toEqual(['p3 is blocked on a question about the retry policy.']);
    expect(decisionsAbout(VIEW, phaseIn('done'))).toEqual([]);
  });
});

describe('the Reviews list', () => {
  it('puts the whole-run findings first, then each phase with where it came from', () => {
    const rows = allFindings(VIEW);
    expect(rows.slice(0, 2).map((row) => [row.finding.id, row.where, row.phaseId])).toEqual([
      ['SEC-7', 'whole run', ''],
      ['DOC-1', 'whole run', ''],
    ]);
    expect(rows.find((row) => row.finding.id === 'PERF-1')).toMatchObject({ where: 'Health endpoint', phaseId: 'p3' });
    expect(rows).toHaveLength(VIEW.finalFindings.length + VIEW.phases.reduce((sum, candidate) => sum + candidate.findings.length, 0));
    expect(new Set(rows.map((row) => row.key)).size).toBe(rows.length);
  });

  it('filters by lens, phase, severity, status and what still blocks', () => {
    const rows = allFindings(VIEW);
    const ids = (filters: FindingFilters): string[] => filterFindings(rows, filters).map((row) => row.finding.id);
    expect(ids({ lens: 'security' }).sort()).toEqual(['SEC-1', 'SEC-2', 'SEC-3', 'SEC-4', 'SEC-7']);
    expect(ids({ phase: 'p3' })).toEqual(['PERF-1', 'SEC-2', 'UX-1']);
    expect(ids({ phase: '' })).toHaveLength(rows.length);
    expect(ids({ phase: 'run' })).toEqual(['SEC-7', 'DOC-1']);
    expect(ids({ severity: 'critical' })).toEqual(['SEC-2']);
    expect(ids({ status: 'fixing' }).sort()).toEqual(['UX-1', 'UX-2']);
    expect(ids({ onlyBlocking: true }).sort()).toEqual(['PERF-1', 'SEC-2', 'SEC-7', 'UX-1', 'UX-2']);
    expect(ids({ lens: 'security', phase: 'p3', onlyBlocking: true })).toEqual(['SEC-2']);
    expect(ids({ lens: 'docs', severity: 'high' })).toEqual([]);
  });

  it('offers only the filter values the findings have', () => {
    const values = filterValues(allFindings(VIEW));
    expect(values.lens.sort()).toEqual(['docs', 'perf', 'security', 'ux']);
    expect(values.severity).toEqual(SEVERITIES);
    expect(values.status).toEqual(FINDING_STATUSES);
    expect(values.phase.map((candidate) => candidate.id)).toEqual(['run', 'p1', 'p3', 'p9', 'p13', 'p14']);
    expect(values.phase[0]?.label).toBe('whole run');
    expect(filterValues([])).toEqual({ lens: [], phase: [], severity: [], status: [] });
  });

  it('counts the list, and how much of it still blocks', () => {
    const rows = allFindings(VIEW);
    expect(countWords(rows)).toBe('11 findings · 5 block');
    expect(countWords(filterFindings(rows, { severity: 'critical' }))).toBe('1 finding · 1 blocks');
    expect(countWords([])).toBe('0 findings');
  });

  it('says every status in people words, with the color it reads in', () => {
    expect(FINDING_STATUSES.map(statusWords)).toEqual(['open', 'being fixed', 'fixed', 'continued by the PM', 'overridden by you', 'advisory']);
    expect(FINDING_STATUSES.map(statusTone)).toEqual(['blocked', 'working', 'pass', 'accent', 'accent', 'dim']);
    expect(['critical', 'high', 'medium', 'low'].map(severityTone)).toEqual(['blocked', 'blocked', 'dim', 'dim']);
    expect(blocksNow(finding('A', 'ux', 'open'))).toBe(true);
    expect(blocksNow(finding('A', 'ux', 'fixed'))).toBe(false);
    expect(blocksNow(finding('A', 'ux', 'advisory'))).toBe(false);
  });

  it('points at the code a finding names', () => {
    expect(fileLine(finding('A', 'ux', 'open', { file: 'src/a.ts', line: 12 }))).toBe('src/a.ts:12');
    expect(fileLine(finding('A', 'ux', 'open', { file: 'src/a.ts' }))).toBe('src/a.ts');
    expect(fileLine(finding('A', 'ux', 'open'))).toBe('');
  });

  it('opens a finding for its fix and the reason it stands', () => {
    expect(detailRows(finding('A', 'ux', 'open', { fix: 'stream it' }))).toEqual([{ label: 'Fix', text: 'stream it' }]);
    expect(detailRows(finding('A', 'ux', 'overridden', { note: 'short lived' }))).toEqual([{ label: 'Why you overrode it', text: 'short lived' }]);
    expect(detailRows(finding('A', 'ux', 'continued', { note: 'not reachable' }))).toEqual([{ label: 'Why it was continued', text: 'not reachable' }]);
    expect(detailRows(finding('A', 'ux', 'open'))).toEqual([]);
  });
});

describe('the Ship preview', () => {
  it("titles the pull request with the goal's first line, cut to a title's length", () => {
    expect(pullRequestTitle(VIEW.goal)).toBe('Add a health check');
    expect(pullRequestTitle('\n\n  Ship it  \nsecond line')).toBe('Ship it');
    expect(pullRequestTitle('')).toBe("A run's work");
    const long = pullRequestTitle('a'.repeat(TITLE_LIMIT + 20));
    expect(long).toHaveLength(TITLE_LIMIT);
    expect(long.endsWith('…')).toBe(true);
  });

  it('lists the phases, the findings with their overrides, and each proof, section by section', () => {
    const sections = previewSections(VIEW);
    expect(sections.map((section) => section.heading)).toEqual(['Phases', 'Findings', 'Proof']);
    const phases = sections[0]?.rows ?? [];
    expect(phases).toHaveLength(VIEW.phases.length);
    expect(phases.find((row) => row.key === 'phase-p3')).toMatchObject({ badge: 'needs you', tone: 'blocked', note: 'waiting on you' });
    expect(phases.find((row) => row.key === 'phase-p1')).toMatchObject({ badge: 'done', tone: 'pass' });
    const findings = sections[1]?.rows ?? [];
    const overridden = findings.find((row) => row.badge.startsWith('overridden'));
    expect(overridden?.note).toContain('the token is short lived');
    expect(overridden?.note).toContain('Repo and config');
    const continued = findings.find((row) => row.badge.startsWith('continued'));
    expect(continued?.note).toContain('not reachable from the UI');
    const blocking = findings.find((row) => row.badge === 'open · critical');
    expect(blocking).toMatchObject({ text: 'The SEC-2 problem', tone: 'blocked' });
    const proof = sections[2]?.rows ?? [];
    expect(proof.map((row) => [row.key, row.badge])).toEqual([
      ['proof-p1', '3 items'],
      ['proof-p3', '1 item'],
    ]);
    expect(proof[0]?.note).toBe('tests, log, manual');
  });

  it('says so when a section has nothing in it', () => {
    const empty: RunView = { ...VIEW, phases: [], finalFindings: [] };
    expect(previewSections(empty).map((section) => [section.heading, section.rows.length, section.empty])).toEqual([
      ['Phases', 0, 'No phases yet.'],
      ['Findings', 0, 'No findings.'],
      ['Proof', 0, 'No proof recorded.'],
    ]);
  });

  it('badges a phase by how it ended', () => {
    expect(phaseBadge(phaseIn('done'))).toEqual({ badge: 'done', tone: 'pass' });
    expect(phaseBadge(phaseIn('stopped'))).toEqual({ badge: 'stopped', tone: 'blocked' });
    expect(phaseBadge(phaseIn('awaitingYou'))).toEqual({ badge: 'needs you', tone: 'blocked' });
    expect(phaseBadge(phaseIn('waiting'))).toEqual({ badge: 'not started', tone: 'dim' });
    expect(phaseBadge(phaseIn('building'))).toEqual({ badge: 'in progress', tone: 'working' });
  });

  it('says where the pull request went', () => {
    expect(whereItWent(null)).toEqual({ words: 'Not opened yet.', url: '', path: '' });
    expect(whereItWent({ url: 'https://github.com/o/r/pull/7' })).toEqual({ words: 'https://github.com/o/r/pull/7', url: 'https://github.com/o/r/pull/7', path: '' });
    expect(whereItWent({ path: '.herd/runs/r-u3/pull-request.md' })).toEqual({ words: '.herd/runs/r-u3/pull-request.md', url: '', path: '.herd/runs/r-u3/pull-request.md' });
    expect(whereItWent({})).toEqual({ words: 'Opened, but the run did not record where.', url: '', path: '' });
  });
});
