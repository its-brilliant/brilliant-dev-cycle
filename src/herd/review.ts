import type { Severity } from '../config/types.js';
import { SEVERITIES } from '../config/types.js';
import { expectEnum, expectId, expectRecord, expectString, hasOwn, unknownFields } from '../fields.js';
import { got, push, type Issue } from '../issues.js';
import { type ReviewerOverride, parseReviewerOverride } from './evidence.js';

const REVIEW_KEYS = ['reviews', 'overrides'] as const;
const ROUND_KEYS = ['reviewer', 'findings'] as const;
const FINDING_KEYS = ['id', 'severity', 'summary', 'location'] as const;

export interface ReviewFinding {
  id: string;
  severity: Severity;
  summary: string;
  location?: string;
}

export interface ReviewerRound {
  reviewer: string;
  findings: ReviewFinding[];
}

/** `runs/<id>/phases/<phase>/review.json`. Overrides here are copied into PR evidence later. */
export interface PhaseReview {
  reviews: ReviewerRound[];
  overrides: ReviewerOverride[];
}

export function parsePhaseReviewJson(text: string, file: string): { review: PhaseReview | null; issues: Issue[] } {
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid JSON';
    return { review: null, issues: [{ file, path: '', message: `invalid JSON (${message})` }] };
  }
  return parsePhaseReview(value, file);
}

export function parsePhaseReview(value: unknown, file: string): { review: PhaseReview | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const root = expectRecord(value, file, '', issues);
  if (!root) return { review: null, issues };
  unknownFields(root, REVIEW_KEYS, file, '', issues);

  const reviews = parseRounds(root, file, issues);
  const overrides = parseOverrides(root, file, issues);
  if (issues.length > 0 || !reviews || !overrides) return { review: null, issues };
  return { review: { reviews, overrides }, issues };
}

/** Flatten phase review overrides in file order. p6 attaches these to the PR. */
export function collectReviewerOverrides(reviews: readonly PhaseReview[]): ReviewerOverride[] {
  return reviews.flatMap((review) => review.overrides);
}

function parseRounds(root: Record<string, unknown>, file: string, issues: Issue[]): ReviewerRound[] | undefined {
  if (!hasOwn(root, 'reviews')) {
    push(issues, file, 'reviews', 'required');
    return undefined;
  }
  if (!Array.isArray(root.reviews)) {
    push(issues, file, 'reviews', `expected a list, got ${got(root.reviews)}`);
    return undefined;
  }
  const rounds: ReviewerRound[] = [];
  let ok = true;
  for (let i = 0; i < root.reviews.length; i++) {
    const round = parseRound(root.reviews[i], file, `reviews[${i}]`, issues);
    if (!round) ok = false;
    else rounds.push(round);
  }
  return ok ? rounds : undefined;
}

function parseRound(value: unknown, file: string, path: string, issues: Issue[]): ReviewerRound | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, ROUND_KEYS, file, path, issues);
  let reviewer: string | undefined;
  if (!hasOwn(obj, 'reviewer')) push(issues, file, `${path}.reviewer`, 'required');
  else reviewer = expectId(obj.reviewer, file, `${path}.reviewer`, issues);
  const findings = parseFindings(obj, file, path, issues);
  if (issues.length > before || reviewer === undefined || !findings) return undefined;
  return { reviewer, findings };
}

function parseFindings(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): ReviewFinding[] | undefined {
  const findingsPath = `${path}.findings`;
  if (!hasOwn(obj, 'findings')) {
    push(issues, file, findingsPath, 'required');
    return undefined;
  }
  if (!Array.isArray(obj.findings)) {
    push(issues, file, findingsPath, `expected a list, got ${got(obj.findings)}`);
    return undefined;
  }
  const findings: ReviewFinding[] = [];
  let ok = true;
  for (let i = 0; i < obj.findings.length; i++) {
    const finding = parseFinding(obj.findings[i], file, `${findingsPath}[${i}]`, issues);
    if (!finding) ok = false;
    else findings.push(finding);
  }
  return ok ? findings : undefined;
}

function parseFinding(value: unknown, file: string, path: string, issues: Issue[]): ReviewFinding | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, FINDING_KEYS, file, path, issues);
  let id: string | undefined;
  if (!hasOwn(obj, 'id')) push(issues, file, `${path}.id`, 'required');
  else id = expectId(obj.id, file, `${path}.id`, issues);
  let severity: Severity | undefined;
  if (!hasOwn(obj, 'severity')) push(issues, file, `${path}.severity`, 'required');
  else severity = expectEnum(obj.severity, SEVERITIES, file, `${path}.severity`, issues);
  let summary: string | undefined;
  if (!hasOwn(obj, 'summary')) push(issues, file, `${path}.summary`, 'required');
  else summary = expectString(obj.summary, file, `${path}.summary`, issues);
  let location: string | undefined;
  if (hasOwn(obj, 'location')) location = expectString(obj.location, file, `${path}.location`, issues);
  if (issues.length > before || id === undefined || severity === undefined || summary === undefined) return undefined;
  const finding: ReviewFinding = { id, severity, summary };
  if (location !== undefined) finding.location = location;
  return finding;
}

function parseOverrides(root: Record<string, unknown>, file: string, issues: Issue[]): ReviewerOverride[] | undefined {
  if (!hasOwn(root, 'overrides')) return [];
  if (!Array.isArray(root.overrides)) {
    push(issues, file, 'overrides', `expected a list, got ${got(root.overrides)}`);
    return undefined;
  }
  const overrides: ReviewerOverride[] = [];
  let ok = true;
  for (let i = 0; i < root.overrides.length; i++) {
    const parsed = parseReviewerOverride(root.overrides[i], file, `overrides[${i}]`);
    issues.push(...parsed.issues);
    if (!parsed.override) ok = false;
    else overrides.push(parsed.override);
  }
  return ok ? overrides : undefined;
}
