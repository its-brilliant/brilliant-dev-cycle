// The Ship screen's facts (spec §4.6, §9.3 "Ship", frame 07): the pull request as bdc will write
// it from the run's evidence — its title, the phases and how they ended, the findings and the
// overrides with their reasons, and each phase's proof. Pure functions over the run's view, so a
// test drives them with a view and no Herdr (tests/herdr/screens-u3.test.ts).
import { plural } from "../kit/words.js";
import { allFindings, blocksNow, statusTone, statusWords } from "./reviews-filters.js";

/** A pull request title's length: long enough to say the goal, short enough for a list. */
export const TITLE_LIMIT = 72;

/** The pull request's title: the goal's first line, cut to a title's length (§4.6). */
export function pullRequestTitle(goal) {
  const first = String(goal ?? "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line !== "");
  if (first === undefined) return "A run's work";
  return first.length <= TITLE_LIMIT ? first : `${first.slice(0, TITLE_LIMIT - 1).trimEnd()}…`;
}

/** A phase's badge in the preview: short enough for a pill, and true about how it ended. */
export function phaseBadge(phase) {
  if (phase.state === "done") return { badge: "done", tone: "pass" };
  if (phase.state === "stopped" || phase.state === "cancelled") return { badge: "stopped", tone: "blocked" };
  if (phase.needsYou) return { badge: "needs you", tone: "blocked" };
  if (phase.state === "waiting") return { badge: "not started", tone: "dim" };
  return { badge: "in progress", tone: "working" };
}

/**
 * The pull request's body, section by section, from what the run recorded (§4.6): the phases and
 * how they ended, the findings and the overrides with their reasons, and each phase's proof.
 * Each row is `{ key, text, note, badge, tone }` so the screen only draws what this decided, and
 * a section with nothing to say carries the line that says so.
 */
export function previewSections(view) {
  return [
    { heading: "Phases", empty: "No phases yet.", rows: phaseRows(view.phases ?? []) },
    { heading: "Findings", empty: "No findings.", rows: findingRows(view) },
    { heading: "Proof", empty: "No proof recorded.", rows: proofRows(view.phases ?? []) },
  ];
}

function phaseRows(phases) {
  return phases.map((phase) => {
    const { badge, tone } = phaseBadge(phase);
    return { key: `phase-${phase.id}`, text: `${phase.id} · ${phase.title}`, note: phase.words, badge, tone };
  });
}

function findingRows(view) {
  return allFindings(view).map((row) => {
    const { finding } = row;
    const settled = finding.status === "continued" || finding.status === "overridden";
    const parts = [row.where, finding.lens];
    if (settled && finding.note !== "") parts.push(finding.note);
    return {
      key: `finding-${row.key}`,
      text: finding.summary,
      note: parts.join(" · "),
      badge: blocksNow(finding) ? `${statusWords(finding.status)} · ${finding.severity}` : statusWords(finding.status),
      tone: statusTone(finding.status),
    };
  });
}

function proofRows(phases) {
  return phases
    .filter((phase) => phase.proof.length > 0)
    .map((phase) => ({
      key: `proof-${phase.id}`,
      text: `${phase.id} · ${phase.title}`,
      note: phase.proof.map((item) => item.kind).join(", "),
      badge: plural(phase.proof.length, "item"),
      tone: "review",
    }));
}

/**
 * Where the pull request went (§4.6): its address when bdc opened one on GitHub, the file it wrote
 * for a local target, or that it is not open yet.
 */
export function whereItWent(pullRequest) {
  if (pullRequest === null || pullRequest === undefined) return { words: "Not opened yet.", url: "", path: "" };
  if (typeof pullRequest.url === "string" && pullRequest.url !== "") return { words: pullRequest.url, url: pullRequest.url, path: "" };
  if (typeof pullRequest.path === "string" && pullRequest.path !== "") return { words: pullRequest.path, url: "", path: pullRequest.path };
  return { words: "Opened, but the run did not record where.", url: "", path: "" };
}
