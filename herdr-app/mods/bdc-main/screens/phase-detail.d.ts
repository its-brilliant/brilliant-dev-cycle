// Types for screens/phase-detail.js, so the TypeScript tests and an editor can check a call.
// Kept by hand next to the module: mods are plain JavaScript Herdr loads as-is, and each shape is
// only the part of `view.json` this module reads (src/contracts/view.ts is the full schema).
import type { FindingLike } from "./reviews-filters.js";

export interface VerificationStepLike {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

export interface VerificationLike {
  passed: boolean;
  steps: VerificationStepLike[];
}

export interface ProofItemLike {
  kind: string;
  shows: string;
  file?: string;
  by: string;
}

/** A phase, as far as its detail screen goes. */
export interface PhaseDetailLike {
  id: string;
  title: string;
  deps: string[];
  findings: FindingLike[];
  verification: VerificationLike | null;
  proof: ProofItemLike[];
}

export interface RunDetailLike {
  runId: string;
  chat: { from: string; text: string }[];
  plan: { phases: { id: string; tasks: { id: string; title: string; paths: string[] }[] }[] } | null;
}

export interface LensGroup {
  lens: string;
  findings: FindingLike[];
  words: string;
  tone: string;
}

export interface StepRow {
  key: string;
  name: string;
  command: string;
  duration: string;
  words: string;
  tone: string;
  outputTail: string;
}

export interface ProofRow {
  key: string;
  kind: string;
  shows: string;
  by: string;
  file: string;
  image: string;
}

export interface Decision {
  key: string;
  text: string;
}

export function tasksOf(view: RunDetailLike, phaseId: string): { id: string; title: string; paths: string[] }[];
export function depsWords(phase: { id: string; deps: string[] }, phases: { id: string; deps: string[] }[]): string;
export function reviewByLens(phase: { findings: FindingLike[] }): LensGroup[];
export function blockingLenses(phase: { findings: FindingLike[] }): string[];
export function durationWords(ms: number): string;
export function verificationRows(phase: { verification: VerificationLike | null }): StepRow[];
export function verificationWords(phase: { verification: VerificationLike | null }): string;
export function byWords(by: string): string;
export function imageFile(view: { runId: string }, item: ProofItemLike, root: string | null): string;
export function proofRows(view: RunDetailLike, phase: { proof: ProofItemLike[] }, root: string | null): ProofRow[];
export function decisionsAbout(view: RunDetailLike, phase: { id: string; title: string }): Decision[];
export function findingNote(finding: FindingLike): string;
