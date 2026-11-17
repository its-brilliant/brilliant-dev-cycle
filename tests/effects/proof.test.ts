/**
 * The real proof check (spec §4.4.1): every required item is there, and each one is what it claims
 * to be. The image and video fixtures are real file headers — the check reads the first bytes and
 * nothing else — and the report fixtures are the shapes test runners actually print.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createActor } from 'xstate';
import type { CheckProofOutput, ProofItem } from '../../src/contracts/actors.js';
import type { ProofKind, ProofRequirement } from '../../src/contracts/domain.js';
import { checkProof, proofEffect } from '../../src/effects/proof.js';

/** A 1×1 PNG, 68 bytes: a real image, small enough to keep in the test. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
/** SOI and the JFIF APP0 segment: what every JPEG starts with (the tables below it change nothing). */
const JPEG = Buffer.from('ffd8ffe000104a46494600010100000100010000', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00\x80\x00\x00\xff\xff\xff\x00\x00\x00;', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.from([0x1a, 0, 0, 0]), Buffer.from('WEBPVP8 ', 'latin1')]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom', 'latin1')]);
const MOV = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  ', 'latin1')]);
const WEBM = Buffer.from('1a45dfa3a34286810142f7810142f2810442f381084282847765626d', 'hex');

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-proof-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Writes a proof file and answers the relative path a verifier would submit. */
function write(name: string, content: string | Buffer): string {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return name;
}

function item(kind: ProofKind, file?: string, by: ProofItem['by'] = 'verifier'): ProofItem {
  return { kind, shows: 'what this shows', by, ...(file === undefined ? {} : { file }) };
}

function requirement(kind: ProofKind): ProofRequirement {
  return { kind, shows: '' };
}

function check(requirements: ProofRequirement[], items: ProofItem[]): CheckProofOutput {
  return checkProof({ requirements, items }, dir);
}

/** The reason a single item was rejected, or null when it was accepted. */
function why(kind: ProofKind, file?: string, by: ProofItem['by'] = 'verifier'): string | null {
  return check([requirement(kind)], [item(kind, file, by)]).invalid[0]?.why ?? null;
}

describe('checkProof', () => {
  it.each([
    ['png', PNG],
    ['jpeg', JPEG],
    ['gif', GIF],
    ['webp', WEBP],
  ])('accepts a %s screenshot', (extension, bytes) => {
    const file = write(`shots/screen.${extension}`, bytes);

    expect(check([requirement('screenshot')], [item('screenshot', file)])).toEqual({
      complete: true,
      missing: [],
      invalid: [],
    });
  });

  it('rejects a screenshot that is not an image', () => {
    const file = write('shots/screen.txt', 'this is not a picture\n');

    expect(why('screenshot', file)).toBe('shots/screen.txt is not an image (PNG, JPEG, WebP or GIF)');
  });

  it('rejects a proof file that is missing or empty', () => {
    const empty = write('shots/empty.png', '');

    expect(why('screenshot', 'shots/nothing.png')).toBe('shots/nothing.png is not there');
    expect(why('screenshot', empty)).toBe('shots/empty.png is empty');
    expect(why('screenshot', undefined)).toBe('the screenshot proof does not name a file');
  });

  // Root reads a 000 file anyway, so the case cannot be staged there.
  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'says a proof file it cannot read could not be read',
    () => {
      const file = write('shots/locked.png', PNG);
      fs.chmodSync(path.join(dir, file), 0o000);

      expect(why('screenshot', file)).toBe('shots/locked.png could not be read');
    },
  );

  it.each([
    ['mp4', MP4],
    ['mov', MOV],
    ['webm', WEBM],
    ['gif', GIF],
  ])('accepts a %s recording', (extension, bytes) => {
    expect(why('recording', write(`runs/run.${extension}`, bytes))).toBeNull();
  });

  it('rejects a recording that is not a video', () => {
    expect(why('recording', write('runs/still.png', PNG))).toBe('runs/still.png is not a video (MP4, MOV, WebM) or a GIF');
  });

  it('accepts a JUnit report with no failures and rejects one that reports them', () => {
    const passed = write(
      'reports/unit.xml',
      '<?xml version="1.0"?>\n<testsuites failures="0" errors="0">\n  <testsuite name="unit" tests="3" failures="0" errors="0"/>\n</testsuites>\n',
    );
    const failed = write(
      'reports/broken.xml',
      '<?xml version="1.0"?>\n<testsuite name="unit" tests="3" failures="2" errors="0"/>\n',
    );

    expect(why('tests', passed)).toBeNull();
    expect(why('tests', failed)).toBe('the test report reports/broken.xml says 2 tests failed');
  });

  it('accepts a test log that prints a pass summary', () => {
    const file = write('reports/vitest.log', ' Test Files  2 passed (2)\n      Tests  12 passed (12)\n');

    expect(why('tests', file)).toBeNull();
  });

  it('does not read a zero failure count as a failure', () => {
    const file = write('reports/jest.log', 'Tests:       0 failed, 5 passed, 5 total\n');

    expect(why('tests', file)).toBeNull();
  });

  it('rejects a test log that reports failures, and one that says nothing about tests', () => {
    const failed = write('reports/jest.log', 'Tests:       1 failed, 11 passed, 12 total\n');
    const silent = write('reports/silent.log', 'building the app\n');

    expect(why('tests', failed)).toBe('the test log reports/jest.log reports failures');
    expect(why('tests', silent)).toBe('the test log reports/silent.log does not say that any test passed');
  });

  it('accepts a non-empty log and rejects an empty one', () => {
    expect(why('log', write('logs/migrate.log', 'migrating 3 tables\n'))).toBeNull();
    expect(why('log', write('logs/blank.log', ''))).toBe('logs/blank.log is empty');
  });

  it('accepts an e2e or walkthrough file that is not empty', () => {
    expect(why('e2e', write('runs/sign-in.md', 'signed in with Google, landed on the dashboard\n'))).toBeNull();
    expect(why('walkthrough', write('runs/tour.md', 'clicked through the new screen\n'))).toBeNull();
  });

  it('lists the requirements that have no item of their kind', () => {
    const screenshot = requirement('screenshot');
    const tests = requirement('tests');
    const output = check([screenshot, tests], [item('screenshot', write('shots/screen.png', PNG))]);

    expect(output.complete).toBe(false);
    expect(output.missing).toEqual([tests]);
    expect(output.invalid).toEqual([]);
  });

  it('accepts manual proof only as a person\'s word without a file', () => {
    const confirmed = check([requirement('manual')], [item('manual', undefined, 'person')]);
    expect(confirmed).toEqual({ complete: true, missing: [], invalid: [] });

    expect(why('manual', undefined, 'verifier')).toBe(
      'only a person can confirm this, and no confirmation from the person was recorded',
    );
    expect(why('manual', write('shots/screen.png', PNG), 'person')).toBe(
      "a person's confirmation is their word; it does not come with a file",
    );
  });

  it('blocks when an extra item the phase offers does not hold up', () => {
    const log = item('log', write('logs/migrate.log', 'migrating\n'));
    const broken = item('screenshot', 'shots/gone.png');
    const output = check([requirement('log')], [log, broken]);

    expect(output.complete).toBe(false);
    expect(output.missing).toEqual([]);
    expect(output.invalid).toEqual([{ item: broken, why: 'shots/gone.png is not there' }]);
  });

  it('resolves relative files against the base directory and takes absolute paths as they are', () => {
    const file = write('proof/nested/screen.png', PNG);

    expect(why('screenshot', file)).toBeNull();
    expect(why('screenshot', path.join(dir, file))).toBeNull();
  });

  it('runs through the effect the machine invokes', async () => {
    const logic = proofEffect({ base: dir });
    const actor = createActor(logic, {
      input: { requirements: [requirement('screenshot')], items: [item('screenshot', write('screen.png', PNG))] },
    });
    const done = new Promise<CheckProofOutput>((resolve, reject) => {
      actor.subscribe((snapshot) => {
        if (snapshot.status === 'done') resolve(snapshot.output as CheckProofOutput);
        if (snapshot.status === 'error') reject(snapshot.error);
      });
    });
    actor.start();

    expect(await done).toEqual({ complete: true, missing: [], invalid: [] });
  });
});

/** 17 Nov 2026: a phase whose checks all passed was blocked because a silent check's empty log was its "tests" proof. */
describe('bdc verification report as proof', () => {
  it('a passing report is test proof, and a failing one names the failed steps', async () => {
    const { checkProof } = await import('../../src/effects/proof.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-report-'));
    try {
      const write = (name: string, passed: boolean, failed: string[]) =>
        fs.writeFileSync(
          path.join(dir, name),
          JSON.stringify({ bdcVerification: 1, runId: 'r1', phaseId: 'p1', passed, steps: [{ name: 'silent check', exitCode: 0 }, ...failed.map((step) => ({ name: step, exitCode: 1 }))] }),
        );
      write('ok.json', true, []);
      write('bad.json', false, ['unit']);
      const requirement = [{ kind: 'tests' as const, shows: 'the checks pass' }];
      expect(checkProof({ requirements: requirement, items: [{ kind: 'tests', shows: '', file: path.join(dir, 'ok.json'), by: 'bdc' }] }, dir).complete).toBe(true);
      const bad = checkProof({ requirements: requirement, items: [{ kind: 'tests', shows: '', file: path.join(dir, 'bad.json'), by: 'bdc' }] }, dir);
      expect(bad.complete).toBe(false);
      expect(bad.invalid[0]?.why).toContain('unit failed');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
