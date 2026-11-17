// Types for screens/build-board.js, so the TypeScript tests and an editor can check a call.
// Kept by hand next to the module: mods are plain JavaScript Herdr loads as-is, and each shape is
// only the part of `view.json` this module reads (src/contracts/view.ts is the full schema).
import type { FindingLike } from "./reviews-filters.js";

/** A phase, as far as its place on the board goes. */
export interface PhaseBoardLike {
  id: string;
  state: string;
  deps: string[];
  words: string;
  needsYou: boolean;
  attemptsUsed: number;
  findings: FindingLike[];
  verification: { passed: boolean; steps: { exitCode: number | null }[] } | null;
}

export type StepStatus = "done" | "active" | "queued" | "waiting";

export interface PhaseStep {
  name: string;
  status: StepStatus;
}

export interface StepPosition {
  done: number;
  active: number | null;
  queued: boolean;
}

export interface DoneCount {
  done: number;
  total: number;
  words: string;
}

export const PHASE_STEPS: string[];
export function stepPosition(phase: PhaseBoardLike): StepPosition;
export function stepTrack(phase: PhaseBoardLike): PhaseStep[];
export function phaseWaves<T extends { id: string; deps: string[] }>(phases: T[]): T[][];
export function phasesDone(phases: { state: string }[]): DoneCount;
export function findingsByStatus(findings: FindingLike[]): Record<string, number>;
export function findingsWords(findings: FindingLike[]): string;
export function checksWords(phase: PhaseBoardLike): string;
export function attemptsWords(phase: { attemptsUsed: number }): string;
export function needsYouWords(phases: { id: string; needsYou: boolean }[]): string;
export function phaseTone(phase: { state: string; needsYou: boolean }): string;
