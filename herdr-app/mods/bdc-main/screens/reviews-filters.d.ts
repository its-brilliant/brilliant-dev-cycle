// Types for screens/reviews-filters.js, so the TypeScript tests and an editor can check a call.
// Kept by hand next to the module: mods are plain JavaScript Herdr loads as-is, and each shape is
// only the part of `view.json` this module reads (src/contracts/view.ts is the full schema).

export interface FindingLike {
  id: string;
  severity: string;
  summary: string;
  file?: string;
  line?: number | null;
  fix?: string;
  lens: string;
  status: string;
  note?: string;
}

/** A phase, as far as its findings go. */
export interface PhaseFindingsLike {
  id: string;
  title: string;
  findings: FindingLike[];
}

export interface RunFindingsLike {
  phases: PhaseFindingsLike[];
  finalFindings: FindingLike[];
}

/** One finding in the run's one list: which it is, and where it came from. */
export interface FindingRow {
  key: string;
  finding: FindingLike;
  where: string;
  phaseId: string;
}

/** What the person asked to see; a missing or empty value is "all". */
export interface FindingFilters {
  lens?: string;
  phase?: string;
  severity?: string;
  status?: string;
  onlyBlocking?: boolean;
}

export interface FilterValues {
  lens: string[];
  phase: { id: string; label: string }[];
  severity: string[];
  status: string[];
}

export interface DetailRow {
  label: string;
  text: string;
}

export const SEVERITIES: string[];
export const FINDING_STATUSES: string[];
export function statusWords(status: string): string;
export function statusTone(status: string): string;
export function blocksNow(finding: FindingLike): boolean;
export function severityTone(severity: string): string;
export function fileLine(finding: FindingLike): string;
export function allFindings(view: RunFindingsLike): FindingRow[];
export function filterValues(rows: FindingRow[]): FilterValues;
export function filterFindings(rows: FindingRow[], filters?: FindingFilters): FindingRow[];
export function countWords(rows: FindingRow[]): string;
export function detailRows(finding: FindingLike): DetailRow[];
