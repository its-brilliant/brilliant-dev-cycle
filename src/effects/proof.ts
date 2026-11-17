/**
 * The real proof check (spec §4.4.1): every proof a phase requires must be there, and each item
 * must be what it claims to be. Nothing here trusts a file name: a screenshot is an image because
 * its first bytes say so, a test report says tests passed in its own words.
 *
 * What each kind has to be, and why the check is no cleverer than this:
 * - `screenshot` — a PNG, JPEG, WebP or GIF by magic bytes. Not decoded: a broken-but-real image
 *   is still the verifier's proof, and an image library is not worth carrying for this.
 * - `recording` — an MP4, MOV or WebM by magic bytes, or a GIF (a short screen recording often is).
 * - `tests` — a JUnit XML report with zero failures and errors, or a log that prints a pass summary
 *   and no failure summary. The log heuristics are the shapes npm/vitest/jest/go/cargo/pytest print
 *   (`12 passed`, `PASS src/x.test.ts`, `ok  1`); a zero count (`0 failed`) is not a failure.
 * - `log` — a non-empty file; the log itself is the evidence.
 * - `e2e`, `walkthrough` — a non-empty file and no more: what a recorded end-to-end run or a
 *   walkthrough looks like depends on the repo's own tooling, and the verifier says in `shows` what
 *   the file is meant to prove.
 * - `manual` — no file at all, and the item is a person's word (`by: 'person'`). Only a person can
 *   judge it (§4.4.1), so anything bdc or the verifier submits as `manual` is not proof.
 *
 * Every reason is in people words: they go into the PM's blocker and the Phase screen (§6, §9).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fromPromise } from 'xstate';
import type { PromiseActorLogic } from 'xstate';

import type { CheckProofInput, CheckProofOutput, ProofItem } from '../contracts/actors.js';

/** Enough of a report to hold its summary: the end of the file, where every runner prints it. */
const REPORT_READ_CHARS = 200_000;
/** Magic bytes are at the start of the file. */
const MAGIC_BYTES = 16;

export interface ProofOptions {
  /** Directory a relative item file is resolved against: the project root. Defaults to the cwd. */
  base?: string;
}

/** `checkProof` (§4.4.1): does every requirement have an item, and is each item what it claims? */
export function proofEffect(options: ProofOptions = {}): PromiseActorLogic<CheckProofOutput, CheckProofInput> {
  const base = options.base ?? process.cwd();
  return fromPromise(async ({ input }) => checkProof(input, base));
}

/** The check itself, without XState: a missing requirement, or an item that does not hold up. */
export function checkProof(input: CheckProofInput, base: string): CheckProofOutput {
  const missing = input.requirements.filter(
    (requirement) => !input.items.some((item) => item.kind === requirement.kind),
  );
  const invalid: Array<{ item: ProofItem; why: string }> = [];
  for (const item of input.items) {
    const why = problemWith(item, base);
    if (why !== null) invalid.push({ item, why });
  }
  // An extra item that does not hold up blocks too: it is evidence the phase offers, and a broken
  // screenshot in the PR is worse than no screenshot.
  return { complete: missing.length === 0 && invalid.length === 0, missing, invalid };
}

function problemWith(item: ProofItem, base: string): string | null {
  if (item.kind === 'manual') {
    if (item.by !== 'person') return 'only a person can confirm this, and no confirmation from the person was recorded';
    if (item.file !== undefined && item.file.trim() !== '') return "a person's confirmation is their word; it does not come with a file";
    return null;
  }
  const file = item.file?.trim() ?? '';
  if (file === '') return `the ${item.kind} proof does not name a file`;
  const full = path.isAbsolute(file) ? file : path.resolve(base, file);
  let size: number;
  try {
    const stat = fs.statSync(full);
    if (!stat.isFile()) return `${file} is not a file`;
    size = stat.size;
  } catch {
    return `${file} is not there`;
  }
  if (size === 0) return `${file} is empty`;

  switch (item.kind) {
    case 'screenshot':
      return isImage(full) ? null : `${file} is not an image (PNG, JPEG, WebP or GIF)`;
    case 'recording':
      return isVideo(full) ? null : `${file} is not a video (MP4, MOV, WebM) or a GIF`;
    case 'tests':
      return testReportProblem(full, file);
    default:
      // `log`, `e2e` and `walkthrough`: a non-empty file is the proof (see the module comment).
      return null;
  }
}

/** A pass summary: `12 passed`, `All 3 tests passed`, a leading `ok`/`PASS` (`go`, `cargo`, jest). */
const PASS_SUMMARY = /(?:^|\s)\d+\s+(?:passed|passing|tests? passed)\b|\ball\s+\d+\s+tests?\s+passed\b|^\s*(?:ok\b|PASS\b|✓|✔)/im;
/** A failure summary: `1 failed`, `3 failures`, `2 errors`, a leading `FAIL`/`not ok`, a cross. */
const FAIL_SUMMARY = /(?:^|\s)(?!0\b)\d+\s+(?:failed|failing|failures?|errors?)\b|^\s*(?:FAIL\b|FAILED\b|not ok\b|✗|✘|×)/im;

function testReportProblem(full: string, file: string): string | null {
  const text = readReport(full);
  if (/<testsuites?\b/i.test(text)) {
    const failures = failuresInXml(text);
    return failures === 0 ? null : `the test report ${file} says ${failures} test${failures === 1 ? '' : 's'} failed`;
  }
  if (FAIL_SUMMARY.test(text)) return `the test log ${file} reports failures`;
  if (!PASS_SUMMARY.test(text)) return `the test log ${file} does not say that any test passed`;
  return null;
}

/** JUnit counts failures and errors in attributes; when a report has neither, its elements say it. */
function failuresInXml(text: string): number {
  let counted = false;
  let failures = 0;
  for (const match of text.matchAll(/\b(?:failures|errors)\s*=\s*["'](\d+)["']/gi)) {
    counted = true;
    failures += Number(match[1]);
  }
  if (counted) return failures;
  return (text.match(/<(?:failure|error)\b/gi) ?? []).length;
}

function readReport(full: string): string {
  const text = fs.readFileSync(full, 'utf8');
  return text.length <= REPORT_READ_CHARS ? text : text.slice(-REPORT_READ_CHARS);
}

type FileKind = 'png' | 'jpeg' | 'gif' | 'webp' | 'webm' | 'iso-bmff' | 'other';

/** The first bytes of a file, which is all a magic-byte check reads. */
function fileKind(full: string): FileKind {
  const bytes = Buffer.alloc(MAGIC_BYTES);
  const fd = fs.openSync(full, 'r');
  let read = 0;
  try {
    read = fs.readSync(fd, bytes, 0, MAGIC_BYTES, 0);
  } finally {
    fs.closeSync(fd);
  }
  const head = bytes.subarray(0, read);
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (head.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  // Matroska/WebM's EBML header.
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  // MP4 and MOV are both ISO base media files: a size, then the `ftyp` box.
  if (head.subarray(4, 8).toString('latin1') === 'ftyp') return 'iso-bmff';
  return 'other';
}

function isImage(full: string): boolean {
  const kind = fileKind(full);
  return kind === 'png' || kind === 'jpeg' || kind === 'gif' || kind === 'webp';
}

function isVideo(full: string): boolean {
  const kind = fileKind(full);
  return kind === 'iso-bmff' || kind === 'webm' || kind === 'gif';
}

function startsWith(bytes: Buffer, magic: number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte);
}
