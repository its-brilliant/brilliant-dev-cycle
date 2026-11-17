// The Build board's facts (spec §4.4, §9.3 "Build (Progress)", frame 03): the phases in
// dependency order and, for each, how far along its five steps it is. Pure functions over the
// run's view, so a test drives them with a view and no Herdr (tests/herdr/screens-u3.test.ts).
import { joinWords, plural } from "../kit/words.js";
import { statusWords } from "./reviews-filters.js";

/** The five steps a phase goes through (§4.4): built, merged, reviewed, verified, proved. */
export const PHASE_STEPS = ["Build", "Merge", "Review", "Verify", "Proof"];

/** Where each phase state sits on that track: the steps behind it, and the step it is on. */
const BY_STATE = {
  waiting: { done: 0, active: null },
  building: { done: 0, active: 0 },
  merging: { done: 1, active: 1 },
  resolving: { done: 1, active: 1 },
  reviewing: { done: 2, active: 2 },
  queuedForVerify: { done: 3, active: 3, queued: true },
  verifying: { done: 3, active: 3 },
  proving: { done: 4, active: 4 },
  passed: { done: 5, active: null },
  done: { done: 5, active: null },
};

/**
 * Where a phase is: `done` counts the steps behind it, `active` is the step it is on (null before
 * it starts and after it passes), `queued` means that step waits for its turn.
 *
 * A phase that waits on the PM, is fixing or has stopped does not say which step it is on, so its
 * own evidence decides: a verification result means it got past review, findings mean it got past
 * merge. That is the closest the view lets this be, and it is right about what it claims.
 */
export function stepPosition(phase) {
  const known = BY_STATE[phase.state];
  if (known !== undefined) return { queued: false, ...known };
  const verification = phase.verification ?? null;
  if (verification !== null && verification.passed) return { done: 4, active: 4, queued: false };
  if (verification !== null) return { done: 3, active: 3, queued: false };
  if (phase.findings.length > 0) return { done: 2, active: 2, queued: false };
  return { done: 0, active: 0, queued: false };
}

/** The five steps with what each is doing: `done`, `active`, `queued` or `waiting`. */
export function stepTrack(phase) {
  const position = stepPosition(phase);
  return PHASE_STEPS.map((name, index) => ({
    name,
    status: index < position.done ? "done" : index === position.active ? (position.queued ? "queued" : "active") : "waiting",
  }));
}

/**
 * The phases in dependency order, as waves: a wave's phases wait only on earlier waves (§4.3's
 * DAG). A dependency the plan does not have is treated as met, and a phase that can never be
 * placed goes in a last wave rather than disappearing.
 */
export function phaseWaves(phases) {
  const known = new Set(phases.map((phase) => phase.id));
  const placed = new Set();
  const remaining = [...phases];
  const waves = [];
  for (;;) {
    const wave = remaining.filter((phase) => phase.deps.every((dep) => !known.has(dep) || placed.has(dep)));
    if (wave.length === 0) break;
    for (const phase of wave) {
      placed.add(phase.id);
      remaining.splice(remaining.indexOf(phase), 1);
    }
    waves.push(wave);
    if (remaining.length === 0) break;
  }
  if (remaining.length > 0) waves.push(remaining);
  return waves;
}

/** "2 of 8 phases done", the run's line over the board (§4.4, frame 03). */
export function phasesDone(phases) {
  const done = phases.filter((phase) => phase.state === "done").length;
  return { done, total: phases.length, words: `${done} of ${plural(phases.length, "phase")} done` };
}

/** How many findings a phase has, by what happened to them (§8.1). */
export function findingsByStatus(findings) {
  const counts = { open: 0, fixing: 0, fixed: 0, continued: 0, overridden: 0, advisory: 0 };
  for (const finding of findings) {
    if (counts[finding.status] !== undefined) counts[finding.status] += 1;
  }
  return counts;
}

/** "2 open · 1 fixed", or "" when the phase has no findings. */
export function findingsWords(findings) {
  const counts = findingsByStatus(findings);
  const parts = [];
  for (const [status, count] of Object.entries(counts)) {
    if (count > 0) parts.push(`${count} ${statusWords(status)}`);
  }
  return parts.join(" · ");
}

/** "3 of 5 checks pass", or "" before the phase has been verified. */
export function checksWords(phase) {
  const verification = phase.verification ?? null;
  if (verification === null) return "";
  const passed = verification.steps.filter((step) => step.exitCode === 0).length;
  return `${passed} of ${plural(verification.steps.length, "check")} pass`;
}

/** "2 attempts used" — only once a phase needed more than one (§4.4). */
export function attemptsWords(phase) {
  return phase.attemptsUsed > 1 ? `${plural(phase.attemptsUsed, "attempt")} used` : "";
}

/**
 * "The PM is asking you about p5-layout — see PM chat." when a phase waits on the person. The
 * question itself lives in PM chat (§4.4, §9.4); the board only points there.
 */
export function needsYouWords(phases) {
  const waiting = phases.filter((phase) => phase.needsYou).map((phase) => phase.id);
  if (waiting.length === 0) return "";
  return `The PM is asking you about ${joinWords(waiting)} — see PM chat.`;
}

/** The color a phase's card reads in: what needs the person, what passed, what is running. */
export function phaseTone(phase) {
  if (phase.needsYou) return "blocked";
  if (phase.state === "done") return "pass";
  if (phase.state === "stopped" || phase.state === "cancelled" || phase.state === "waiting") return "dim";
  return "working";
}
