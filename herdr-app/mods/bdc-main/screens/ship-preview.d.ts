// Types for screens/ship-preview.js, so the TypeScript tests and an editor can check a call.
// Kept by hand next to the module: mods are plain JavaScript Herdr loads as-is, and each shape is
// only the part of `view.json` this module reads (src/contracts/view.ts is the full schema).
import type { FindingLike } from "./reviews-filters.js";

/** A phase, as far as the pull request's body goes. */
export interface PhasePreviewLike {
  id: string;
  title: string;
  state: string;
  words: string;
  needsYou: boolean;
  proof: { kind: string }[];
}

export interface RunPreviewLike {
  goal: string;
  phases: PhasePreviewLike[];
  finalFindings: FindingLike[];
}

/** One line of the pull request's body: what it says, the line under it and the pill beside it. */
export interface PreviewRow {
  key: string;
  text: string;
  note: string;
  badge: string;
  tone: string;
}

export interface PreviewSection {
  heading: string;
  empty: string;
  rows: PreviewRow[];
}

export interface PullRequestTarget {
  words: string;
  url: string;
  path: string;
}

export const TITLE_LIMIT: number;
export function pullRequestTitle(goal: string): string;
export function phaseBadge(phase: PhasePreviewLike): { badge: string; tone: string };
export function previewSections(view: RunPreviewLike): PreviewSection[];
export function whereItWent(pullRequest: { url?: string; path?: string } | null | undefined): PullRequestTarget;
