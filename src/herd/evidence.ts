import type { BlockOn, Severity } from '../config/types.js';
import { expectId, expectRecord, expectString, hasOwn, unknownFields } from '../fields.js';
import { got, push, type Issue } from '../issues.js';
import { isIsoUtc } from '../time.js';

const OVERRIDE_KEYS = ['who', 'reviewer', 'reason', 'at'] as const;
const EVIDENCE_KEYS = ['spec_ref', 'phase_ids', 'reviewer_overrides', 'verify_logs', 'artifacts'] as const;

const SEVERITY_RANK: Record<Severity, number> = { low: 1, medium: 2, high: 3 };

/**
 * Operator override of a blocking reviewer.
 * The ship flow records who overrode, which reviewer, and why, on the PR evidence.
 * p1 only models the record.
 */
export interface ReviewerOverride {
  /** Operator identity. */
  who: string;
  /** Reviewer lens that was blocking, such as `security`. */
  reviewer: string;
  /** Why the block was overridden. */
  reason: string;
  /** ISO-8601 UTC time the override was recorded, when known. */
  at?: string;
}

/** Evidence a later phase attaches to the PR. Opening the PR is not part of p1. */
export interface PrEvidence {
  spec_ref: string;
  phase_ids: string[];
  reviewer_overrides: ReviewerOverride[];
  verify_logs: string[];
  artifacts: string[];
}

export interface OverrideParseResult {
  override: ReviewerOverride | null;
  issues: Issue[];
}

/**
 * Whether a finding at `severity` blocks when the reviewer's threshold is `blockOn`.
 * `any` blocks every severity. `none` blocks nothing.
 * With the current severities, `low` also blocks every finding.
 */
export function findingBlocks(severity: Severity, blockOn: BlockOn): boolean {
  if (blockOn === 'none') return false;
  if (blockOn === 'any') return true;
  return SEVERITY_RANK[severity] >= SEVERITY_RANK[blockOn];
}

export function parseReviewerOverride(value: unknown, file: string, path: string): OverrideParseResult {
  const issues: Issue[] = [];
  const override = readOverride(value, file, path, issues);
  if (!override || issues.length > 0) return { override: null, issues };
  return { override, issues };
}

export function parsePrEvidence(value: unknown, file = 'evidence'): { evidence: PrEvidence | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const root = expectRecord(value, file, '', issues);
  if (!root) return { evidence: null, issues };
  unknownFields(root, EVIDENCE_KEYS, file, '', issues);

  let specRef: string | undefined;
  if (!hasOwn(root, 'spec_ref')) push(issues, file, 'spec_ref', 'required');
  else specRef = expectString(root.spec_ref, file, 'spec_ref', issues);

  const phaseIds = readIdList(root, 'phase_ids', file, issues);
  const overrides = readOverrides(root, file, issues);
  const verifyLogs = readStringList(root, 'verify_logs', file, issues);
  const artifacts = readStringList(root, 'artifacts', file, issues);

  if (
    issues.length > 0 ||
    specRef === undefined ||
    phaseIds === undefined ||
    overrides === undefined ||
    verifyLogs === undefined ||
    artifacts === undefined
  ) {
    return { evidence: null, issues };
  }
  return {
    evidence: {
      spec_ref: specRef,
      phase_ids: phaseIds,
      reviewer_overrides: overrides,
      verify_logs: verifyLogs,
      artifacts,
    },
    issues,
  };
}

/** Append a validated override. The evidence is unchanged when the record is invalid. */
export function withReviewerOverride(
  evidence: PrEvidence,
  value: unknown,
  file = 'evidence',
): { evidence: PrEvidence; issues: Issue[] } {
  const parsed = parseReviewerOverride(value, file, 'reviewer_overrides');
  if (!parsed.override) return { evidence, issues: parsed.issues };
  return {
    evidence: {
      ...evidence,
      reviewer_overrides: [...evidence.reviewer_overrides, parsed.override],
    },
    issues: [],
  };
}

function readOverride(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): ReviewerOverride | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, OVERRIDE_KEYS, file, path, issues);
  const who = requireText(obj, 'who', file, path, issues);
  const reviewer = requireReviewer(obj, file, path, issues);
  const reason = requireText(obj, 'reason', file, path, issues);
  const at = readAt(obj, file, path, issues);
  if (who === undefined || reviewer === undefined || reason === undefined || at === 'invalid' || issues.length > before) {
    return undefined;
  }
  const override: ReviewerOverride = { who, reviewer, reason };
  if (at) override.at = at;
  return override;
}

function requireText(
  obj: Record<string, unknown>,
  key: 'who' | 'reason',
  file: string,
  base: string,
  issues: Issue[],
): string | undefined {
  const path = base ? `${base}.${key}` : key;
  if (!hasOwn(obj, key)) {
    push(issues, file, path, 'required');
    return undefined;
  }
  return expectString(obj[key], file, path, issues);
}

function requireReviewer(
  obj: Record<string, unknown>,
  file: string,
  base: string,
  issues: Issue[],
): string | undefined {
  const path = base ? `${base}.reviewer` : 'reviewer';
  if (!hasOwn(obj, 'reviewer')) {
    push(issues, file, path, 'required');
    return undefined;
  }
  return expectId(obj.reviewer, file, path, issues);
}

function readAt(
  obj: Record<string, unknown>,
  file: string,
  base: string,
  issues: Issue[],
): string | undefined | 'invalid' {
  if (!hasOwn(obj, 'at')) return undefined;
  const path = base ? `${base}.at` : 'at';
  if (typeof obj.at !== 'string' || !isIsoUtc(obj.at)) {
    push(issues, file, path, `expected an ISO-8601 UTC timestamp (2026-01-01T00:00:00Z), got ${got(obj.at)}`);
    return 'invalid';
  }
  return obj.at;
}

function readIdList(
  root: Record<string, unknown>,
  key: 'phase_ids',
  file: string,
  issues: Issue[],
): string[] | undefined {
  if (!hasOwn(root, key)) {
    push(issues, file, key, 'required');
    return undefined;
  }
  if (!Array.isArray(root[key])) {
    push(issues, file, key, `expected a list, got ${got(root[key])}`);
    return undefined;
  }
  const values = root[key] as unknown[];
  const ids: string[] = [];
  let ok = true;
  for (let i = 0; i < values.length; i++) {
    const id = expectId(values[i], file, `${key}[${i}]`, issues);
    if (id === undefined) ok = false;
    else ids.push(id);
  }
  return ok ? ids : undefined;
}

function readStringList(
  root: Record<string, unknown>,
  key: 'verify_logs' | 'artifacts',
  file: string,
  issues: Issue[],
): string[] | undefined {
  if (!hasOwn(root, key)) {
    push(issues, file, key, 'required');
    return undefined;
  }
  if (!Array.isArray(root[key])) {
    push(issues, file, key, `expected a list, got ${got(root[key])}`);
    return undefined;
  }
  const values = root[key] as unknown[];
  const items: string[] = [];
  let ok = true;
  for (let i = 0; i < values.length; i++) {
    const item = expectString(values[i], file, `${key}[${i}]`, issues);
    if (item === undefined) ok = false;
    else items.push(item);
  }
  return ok ? items : undefined;
}

function readOverrides(root: Record<string, unknown>, file: string, issues: Issue[]): ReviewerOverride[] | undefined {
  if (!hasOwn(root, 'reviewer_overrides')) {
    push(issues, file, 'reviewer_overrides', 'required');
    return undefined;
  }
  if (!Array.isArray(root.reviewer_overrides)) {
    push(issues, file, 'reviewer_overrides', `expected a list, got ${got(root.reviewer_overrides)}`);
    return undefined;
  }
  const overrides: ReviewerOverride[] = [];
  let ok = true;
  for (let i = 0; i < root.reviewer_overrides.length; i++) {
    const before = issues.length;
    const override = readOverride(root.reviewer_overrides[i], file, `reviewer_overrides[${i}]`, issues);
    if (!override || issues.length > before) ok = false;
    else overrides.push(override);
  }
  return ok ? overrides : undefined;
}
