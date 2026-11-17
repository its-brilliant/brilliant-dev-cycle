// The Reviews screen's facts (spec §8.1): every finding of the run in one list, what happened to
// each, and the filters over them. Pure functions over the run's view, so a test drives them with
// a view and no Herdr (tests/herdr/screens-u3.test.ts).
import { plural } from "../kit/words.js";

/** The severities, worst first. */
export const SEVERITIES = ["critical", "high", "medium", "low"];

/** A finding's status in the order a person reads them (§8.1: open first, notes last). */
export const FINDING_STATUSES = ["open", "fixing", "fixed", "continued", "overridden", "advisory"];

/** What a finding's status means, in people words (§8.1, §9.1 rule 4). */
export function statusWords(status) {
  switch (status) {
    case "open":
      return "open";
    case "fixing":
      return "being fixed";
    case "fixed":
      return "fixed";
    case "continued":
      return "continued by the PM";
    case "overridden":
      return "overridden by you";
    case "advisory":
      return "advisory";
    default:
      return status;
  }
}

/** The color a status reads in: what blocks is red, what is being fixed amber, what settled green. */
export function statusTone(status) {
  switch (status) {
    case "open":
      return "blocked";
    case "fixing":
      return "working";
    case "fixed":
      return "pass";
    case "continued":
    case "overridden":
      return "accent";
    default:
      return "dim";
  }
}

/** A finding that still stands between the run and its pull request. */
export function blocksNow(finding) {
  return finding.status === "open" || finding.status === "fixing";
}

/** A severity's color: critical and high stop the run, the rest are notes. */
export function severityTone(severity) {
  return severity === "critical" || severity === "high" ? "blocked" : "dim";
}

/** `src/a.ts:12`, just the file, or "" when the finding points nowhere. */
export function fileLine(finding) {
  if (typeof finding.file !== "string" || finding.file === "") return "";
  return finding.line === undefined || finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
}

/**
 * Every finding of the run in one list (§8.1): the whole-run review's first, then each phase's,
 * each with where it came from. `phaseKey` is what the phase filter matches: the phase id, or
 * "run" for the whole run (an empty filter value means "all", so it cannot also mean the run).
 */
export function allFindings(view) {
  const rows = [];
  const run = view.finalFindings ?? [];
  run.forEach((finding, index) => rows.push({ key: `run-${index}`, finding, where: "whole run", phaseId: "", phaseKey: "run" }));
  for (const phase of view.phases ?? []) {
    phase.findings.forEach((finding, index) => rows.push({ key: `${phase.id}-${index}`, finding, where: phase.title, phaseId: phase.id, phaseKey: phase.id }));
  }
  return rows;
}

/** The values each filter offers, from the findings themselves, so no filter offers nothing. */
export function filterValues(rows) {
  const lens = [];
  const phase = [];
  for (const row of rows) {
    if (!lens.includes(row.finding.lens)) lens.push(row.finding.lens);
    if (!phase.some((value) => value.id === row.phaseKey)) phase.push({ id: row.phaseKey, label: row.where });
  }
  return {
    lens,
    phase,
    severity: SEVERITIES.filter((severity) => rows.some((row) => row.finding.severity === severity)),
    status: FINDING_STATUSES.filter((status) => rows.some((row) => row.finding.status === status)),
  };
}

/**
 * The findings the person asked to see: `filters` holds one value per dimension (a missing or
 * empty value is "all"), and `onlyBlocking` keeps what still blocks the run.
 */
export function filterFindings(rows, filters = {}) {
  const wanted = (value, chosen) => chosen === undefined || chosen === "" || value === chosen;
  return rows.filter(
    (row) =>
      wanted(row.finding.lens, filters.lens) &&
      wanted(row.phaseKey, filters.phase) &&
      wanted(row.finding.severity, filters.severity) &&
      wanted(row.finding.status, filters.status) &&
      (filters.onlyBlocking !== true || blocksNow(row.finding)),
  );
}

/** "12 findings · 3 block" for the list's header. */
export function countWords(rows) {
  const blocking = rows.filter((row) => blocksNow(row.finding)).length;
  if (blocking === 0) return plural(rows.length, "finding");
  return `${plural(rows.length, "finding")} · ${blocking} ${blocking === 1 ? "blocks" : "block"}`;
}

/** What a finding's full text shows when it is opened (§8.1): the fix it suggests and why it stands. */
export function detailRows(finding) {
  const rows = [];
  if (typeof finding.fix === "string" && finding.fix !== "") rows.push({ label: "Fix", text: finding.fix });
  if (typeof finding.note === "string" && finding.note !== "") {
    rows.push({ label: finding.status === "overridden" ? "Why you overrode it" : "Why it was continued", text: finding.note });
  }
  return rows;
}
