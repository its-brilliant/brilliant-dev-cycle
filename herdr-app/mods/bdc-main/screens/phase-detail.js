// The phase screen's facts (spec §4.4, §9.3 "Phase detail", frame 04): the tasks the phase was
// planned with, what each review lens found, the verification steps with their output, the proof
// it came with, and what the PM said about it. Pure functions over the run's view, so a test
// drives them with a view and no Herdr (tests/herdr/screens-u3.test.ts).
import { join } from "path";
import { joinWords, plural } from "../kit/words.js";

/**
 * The plan's tasks for a phase. `PhaseView` carries no tasks, so they come from the plan the run
 * was approved with (`view.plan.phases[].tasks`), which is the same list the phase was built from.
 */
export function tasksOf(view, phaseId) {
  const planned = (view?.plan?.phases ?? []).find((candidate) => candidate.id === phaseId);
  return planned === undefined ? [] : planned.tasks;
}

/** "Needs p1 and p2 · unlocks p6", or "Starts first" for a phase with no dependencies. */
export function depsWords(phase, phases) {
  const needs = phase.deps.length === 0 ? "Starts first" : `Needs ${joinWords(phase.deps)}`;
  const unlocks = phases.filter((other) => other.deps.includes(phase.id)).map((other) => other.id);
  return unlocks.length === 0 ? needs : `${needs} · unlocks ${joinWords(unlocks)}`;
}

/**
 * A phase's findings, lens by lens (§8.1: one reviewer per lens). A lens's words say whether it
 * still blocks, and its tone colors that.
 */
export function reviewByLens(phase) {
  const byLens = new Map();
  for (const finding of phase.findings) {
    const list = byLens.get(finding.lens) ?? [];
    list.push(finding);
    byLens.set(finding.lens, list);
  }
  return [...byLens.entries()].map(([lens, findings]) => {
    const open = findings.filter((finding) => finding.status === "open").length;
    const fixing = findings.filter((finding) => finding.status === "fixing").length;
    return {
      lens,
      findings,
      words: open > 0 ? `${plural(open, "finding")} open` : plural(findings.length, "finding"),
      tone: open > 0 ? "blocked" : fixing > 0 ? "working" : "pass",
    };
  });
}

/** The lenses whose findings still block the phase: the ones an override can answer (§6). */
export function blockingLenses(phase) {
  return reviewByLens(phase)
    .filter((lens) => lens.findings.some((finding) => finding.status === "open"))
    .map((lens) => lens.lens);
}

/** "1m 05s", "11s" — a duration a person reads. */
export function durationWords(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}m` : `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

/** Each verification step: whether it passed, what it ran, how long it took, and its output tail. */
export function verificationRows(phase) {
  const verification = phase.verification ?? null;
  if (verification === null) return [];
  return verification.steps.map((step, index) => ({
    key: `${index}-${step.name}`,
    name: step.name,
    command: step.command,
    duration: durationWords(step.durationMs),
    words: step.exitCode === 0 ? "passed" : step.exitCode === null ? "not run" : "failed",
    tone: step.exitCode === 0 ? "pass" : step.exitCode === null ? "dim" : "blocked",
    outputTail: step.outputTail ?? "",
  }));
}

/** "3 of 5 checks pass · 2m 10s" for the verification card's heading. */
export function verificationWords(phase) {
  const verification = phase.verification ?? null;
  if (verification === null) return "Not verified yet.";
  const passed = verification.steps.filter((step) => step.exitCode === 0).length;
  const total = verification.steps.length;
  const totalMs = verification.steps.reduce((sum, step) => sum + step.durationMs, 0);
  const duration = durationWords(totalMs);
  const head = verification.passed ? `${passed} of ${plural(total, "check")} passed` : `${passed} of ${plural(total, "check")} pass`;
  return duration === "" ? head : `${head} · ${duration}`;
}

/** Who made a proof item (§4.4.1: bdc itself, the verifier, or you). */
export function byWords(by) {
  if (by === "person") return "you";
  if (by === "verifier") return "the verifier";
  return "bdc";
}

/**
 * The absolute path of a screenshot, for the thumbnail. The view names proof files relative to the
 * run's folder (`.herd/runs/<run>/`), so the project folder and the run id make it absolute.
 */
export function imageFile(view, item, root) {
  if (item.kind !== "screenshot") return "";
  if (typeof item.file !== "string" || item.file === "") return "";
  if (typeof root !== "string" || root === "") return "";
  return join(root, ".herd", "runs", view.runId, item.file);
}

/** Each proof item: what it shows, who made it, and the file when there is one. */
export function proofRows(view, phase, root) {
  return phase.proof.map((item, index) => ({
    key: `${index}-${item.kind}`,
    kind: item.kind,
    shows: item.shows === "" ? item.kind : item.shows,
    by: byWords(item.by),
    file: item.file ?? "",
    image: imageFile(view, item, root),
  }));
}

/**
 * What the PM said about this phase: the run's chat lines that name it. The view does not carry
 * the PM's decisions per phase yet, so a line that mentions the phase is the record (§4.4, §6).
 */
export function decisionsAbout(view, phase) {
  const names = [phase.id, phase.title].filter((name) => typeof name === "string" && name !== "");
  return (view.chat ?? [])
    .filter((entry) => entry.from === "pm" && names.some((name) => entry.text.includes(name)))
    .map((entry, index) => ({ key: `said-${index}`, text: entry.text }));
}

/** A finding's reason when it was continued or overridden: the words a person needs to judge it. */
export function findingNote(finding) {
  return typeof finding.note === "string" ? finding.note : "";
}
