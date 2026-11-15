import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseBdcYaml } from './config/parse.js';
import { isSafeId } from './fields.js';
import { parseComments } from './herd/comments.js';
import { commentVersion, lineCount, specVersion } from './herd/names.js';
import { parsePhasesYaml } from './herd/phases.js';
import { parseQuestions } from './herd/questions.js';
import { parsePhaseReviewJson } from './herd/review.js';
import { parseRunStateJson } from './herd/state.js';
import type { Phase } from './herd/types.js';
import { push, type Issue } from './issues.js';

const PHASE_RUN_FILES = new Set(['review.json', 'verify.log']);
const RUN_FILES = new Set(['state.json', 'questions.jsonl']);

/**
 * Validate a project directory: `bdc.yaml` and the `.herd/` file model.
 * Issues use paths relative to `dir`. An empty list means the project is valid.
 */
export function validateProject(dir: string): Issue[] {
  const issues: Issue[] = [];
  const root = path.resolve(dir);
  if (!isDirectory(root)) {
    push(issues, '.', '', 'not a directory');
    return issues;
  }

  const reviewerNames = readConfig(root, issues);
  readHerd(root, issues, reviewerNames);
  return issues;
}

function readConfig(root: string, issues: Issue[]): string[] | null {
  const text = readText(root, 'bdc.yaml', issues);
  if (text === null) return null;
  const parsed = parseBdcYaml(text, 'bdc.yaml');
  issues.push(...parsed.issues);
  return parsed.reviewerNames;
}

function readHerd(root: string, issues: Issue[], reviewerNames: string[] | null): Phase[] | null {
  const herdLabel = '.herd';
  const herd = path.join(root, '.herd');
  if (!isDirectory(herd)) {
    push(issues, herdLabel, '', 'directory not found');
    return null;
  }

  const specFiles = new Map<number, { file: string; lines: number }>();
  let sawPhasesFile = false;
  let commentsDir = false;
  let reviewersDir = false;
  let runsDir = false;

  for (const entry of listSorted(herd)) {
    const name = entry.name;
    if (name === 'phases.yaml' && entry.isFile()) {
      sawPhasesFile = true;
      continue;
    }
    if (name === 'comments' && entry.isDirectory()) {
      commentsDir = true;
      continue;
    }
    if (name === 'reviewers' && entry.isDirectory()) {
      reviewersDir = true;
      continue;
    }
    if (name === 'runs' && entry.isDirectory()) {
      runsDir = true;
      continue;
    }
    if (name === 'spec.md' && entry.isFile()) {
      const text = readText(root, '.herd/spec.md', issues);
      if (text !== null && text.trim() === '') push(issues, '.herd/spec.md', '', 'spec is empty');
      continue;
    }
    const version = specVersion(name);
    if (version !== undefined && entry.isFile()) {
      const file = `.herd/${name}`;
      const text = readText(root, file, issues);
      if (text !== null) {
        if (text.trim() === '') push(issues, file, '', 'spec is empty');
        specFiles.set(version, { file, lines: lineCount(text) });
      }
      continue;
    }
    push(issues, `.herd/${name}`, '', 'unexpected file');
  }

  checkSpecVersions(specFiles, issues);
  const phases = sawPhasesFile ? readPhases(root, issues) : missing(issues, '.herd/phases.yaml');
  if (commentsDir) readComments(root, specFiles, issues);
  else if (existsSync(path.join(herd, 'comments'))) {
    push(issues, '.herd/comments', '', 'expected a directory');
  }
  readReviewerPrompts(root, reviewerNames, reviewersDir, issues);
  if (runsDir) readRuns(root, phases, reviewerNames, issues);
  return phases;
}

function checkSpecVersions(specFiles: Map<number, { file: string; lines: number }>, issues: Issue[]): void {
  const versions = [...specFiles.keys()].sort((a, b) => a - b);
  if (versions.length === 0) {
    push(issues, '.herd', '', 'expected at least one versioned spec (spec.vN.md)');
    return;
  }
  const last = versions[versions.length - 1] ?? 1;
  for (let version = 1; version <= last; version++) {
    if (!specFiles.has(version)) push(issues, `.herd/spec.v${version}.md`, '', 'file not found');
  }
}

function readPhases(root: string, issues: Issue[]): Phase[] | null {
  const text = readText(root, '.herd/phases.yaml', issues);
  if (text === null) return null;
  const parsed = parsePhasesYaml(text, '.herd/phases.yaml');
  issues.push(...parsed.issues);
  return parsed.phases;
}

function readComments(
  root: string,
  specFiles: Map<number, { file: string; lines: number }>,
  issues: Issue[],
): void {
  const dir = path.join(root, '.herd', 'comments');
  for (const entry of listSorted(dir)) {
    const file = `.herd/comments/${entry.name}`;
    if (!entry.isFile()) {
      push(issues, file, '', 'unexpected file');
      continue;
    }
    const version = commentVersion(entry.name);
    if (version === undefined) {
      push(issues, file, '', 'expected spec.vN.jsonl');
      continue;
    }
    const spec = specFiles.get(version);
    if (!spec) {
      push(issues, file, '', `no spec.v${version}.md for this comment file`);
      continue;
    }
    const text = readText(root, file, issues);
    if (text === null) continue;
    const parsed = parseComments(text, file, { maxLine: spec.lines, specFile: spec.file });
    issues.push(...parsed.issues);
  }
}

function readReviewerPrompts(
  root: string,
  reviewerNames: string[] | null,
  reviewersDir: boolean,
  issues: Issue[],
): void {
  const dir = path.join(root, '.herd', 'reviewers');
  const present = new Set<string>();
  if (reviewersDir) {
    for (const entry of listSorted(dir)) {
      const file = `.herd/reviewers/${entry.name}`;
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        push(issues, file, '', 'unexpected file');
        continue;
      }
      const lens = entry.name.slice(0, -'.md'.length);
      if (!isSafeId(lens)) {
        push(issues, file, '', 'unexpected file');
        continue;
      }
      present.add(lens);
      const text = readText(root, file, issues);
      if (text !== null && text.trim() === '') push(issues, file, '', 'reviewer prompt is empty');
    }
  } else if (existsSync(dir)) {
    push(issues, '.herd/reviewers', '', 'expected a directory');
  }

  if (reviewerNames === null) return;
  for (const name of reviewerNames) {
    if (!isSafeId(name)) continue;
    if (!present.has(name)) push(issues, `.herd/reviewers/${name}.md`, '', 'file not found');
  }
  for (const lens of present) {
    if (!reviewerNames.includes(lens)) {
      push(issues, `.herd/reviewers/${lens}.md`, '', `no reviewers.${lens} entry in bdc.yaml`);
    }
  }
}

function readRuns(
  root: string,
  phases: Phase[] | null,
  reviewerNames: string[] | null,
  issues: Issue[],
): void {
  const dir = path.join(root, '.herd', 'runs');
  for (const entry of listSorted(dir)) {
    const file = `.herd/runs/${entry.name}`;
    if (!entry.isDirectory() || !isSafeId(entry.name)) {
      push(issues, file, '', 'expected a run directory');
      continue;
    }
    readRun(root, entry.name, phases, reviewerNames, issues);
  }
}

function readRun(
  root: string,
  runId: string,
  phases: Phase[] | null,
  reviewerNames: string[] | null,
  issues: Issue[],
): void {
  const dir = path.join(root, '.herd', 'runs', runId);
  const base = `.herd/runs/${runId}`;
  let sawState = false;
  let sawPhaseDir = false;
  for (const entry of listSorted(dir)) {
    if (entry.name === 'state.json' && entry.isFile()) {
      sawState = true;
      continue;
    }
    if (entry.name === 'questions.jsonl' && entry.isFile()) continue;
    if (entry.name === 'phases' && entry.isDirectory()) {
      sawPhaseDir = true;
      continue;
    }
    if (!RUN_FILES.has(entry.name)) push(issues, `${base}/${entry.name}`, '', 'unexpected file');
  }
  if (!sawState) push(issues, `${base}/state.json`, '', 'file not found');
  else {
    const text = readText(root, `${base}/state.json`, issues);
    if (text !== null) {
      const parsed = parseRunStateJson(text, `${base}/state.json`);
      issues.push(...parsed.issues);
      if (parsed.state) crossCheckState(parsed.state, runId, phases, `${base}/state.json`, issues);
    }
  }

  const questionsPath = `${base}/questions.jsonl`;
  if (existsSync(path.join(dir, 'questions.jsonl'))) {
    const text = readText(root, questionsPath, issues);
    if (text !== null) {
      const parsed = parseQuestions(text, questionsPath);
      issues.push(...parsed.issues);
      if (parsed.questions && phases) crossCheckQuestions(parsed.questions, phases, questionsPath, issues);
    }
  }

  if (sawPhaseDir) readRunPhases(root, runId, phases, reviewerNames, issues);
}

function crossCheckState(
  state: { run_id: string; phases: Record<string, { tasks: Record<string, unknown> }> },
  runId: string,
  phases: Phase[] | null,
  file: string,
  issues: Issue[],
): void {
  if (state.run_id !== runId) {
    push(issues, file, 'run_id', `run_id does not match directory ${JSON.stringify(runId)}`);
  }
  if (!phases) return;
  const expected = new Set(phases.map((phase) => phase.id));
  for (const id of expected) {
    if (!state.phases[id]) push(issues, file, `phases.${id}`, 'missing from run state');
  }
  for (const id of Object.keys(state.phases)) {
    if (!expected.has(id)) push(issues, file, `phases.${id}`, `unknown phase ${JSON.stringify(id)}`);
  }
  for (const phase of phases) {
    const tasks = state.phases[phase.id]?.tasks;
    if (!tasks) continue;
    const expectedTasks = new Set(phase.tasks.map((task) => task.id));
    for (const id of expectedTasks) {
      if (!tasks[id]) push(issues, file, `phases.${phase.id}.tasks.${id}`, 'missing from run state');
    }
    for (const id of Object.keys(tasks)) {
      if (!expectedTasks.has(id)) {
        push(issues, file, `phases.${phase.id}.tasks.${id}`, `unknown task ${JSON.stringify(id)}`);
      }
    }
  }
}

function crossCheckQuestions(
  questions: Array<{ phase_id?: string; task_id?: string; id: string }>,
  phases: Phase[],
  file: string,
  issues: Issue[],
): void {
  const byId = new Map(phases.map((phase) => [phase.id, phase]));
  for (const question of questions) {
    if (question.phase_id === undefined) continue;
    const phase = byId.get(question.phase_id);
    if (!phase) {
      push(issues, file, `id ${question.id}`, `unknown phase ${JSON.stringify(question.phase_id)}`);
      continue;
    }
    if (question.task_id !== undefined && !phase.tasks.some((task) => task.id === question.task_id)) {
      push(issues, file, `id ${question.id}`, `unknown task ${JSON.stringify(question.task_id)}`);
    }
  }
}

function readRunPhases(
  root: string,
  runId: string,
  phases: Phase[] | null,
  reviewerNames: string[] | null,
  issues: Issue[],
): void {
  const dir = path.join(root, '.herd', 'runs', runId, 'phases');
  const known = phases ? new Set(phases.map((phase) => phase.id)) : null;
  for (const entry of listSorted(dir)) {
    const base = `.herd/runs/${runId}/phases/${entry.name}`;
    if (!entry.isDirectory() || !isSafeId(entry.name)) {
      push(issues, base, '', 'expected a phase directory');
      continue;
    }
    if (known && !known.has(entry.name)) {
      push(issues, base, '', `unknown phase ${JSON.stringify(entry.name)}`);
    }
    for (const child of listSorted(path.join(dir, entry.name))) {
      const childFile = `${base}/${child.name}`;
      if (child.name === 'evidence' && child.isDirectory()) continue;
      if (child.name === 'verify.log' && child.isFile()) continue;
      if (child.name === 'review.json' && child.isFile()) {
        const text = readText(root, childFile, issues);
        if (text === null) continue;
        const parsed = parsePhaseReviewJson(text, childFile);
        issues.push(...parsed.issues);
        if (parsed.review && reviewerNames) {
          parsed.review.reviews.forEach((round, index) => {
            if (!reviewerNames.includes(round.reviewer)) {
              push(
                issues,
                childFile,
                `reviews[${index}].reviewer`,
                `unknown reviewer ${JSON.stringify(round.reviewer)}`,
              );
            }
          });
          parsed.review.overrides.forEach((override, index) => {
            if (!reviewerNames.includes(override.reviewer)) {
              push(
                issues,
                childFile,
                `overrides[${index}].reviewer`,
                `unknown reviewer ${JSON.stringify(override.reviewer)}`,
              );
            }
          });
        }
        continue;
      }
      if (!PHASE_RUN_FILES.has(child.name)) push(issues, childFile, '', 'unexpected file');
    }
  }
}

function missing(issues: Issue[], file: string): null {
  push(issues, file, '', 'file not found');
  return null;
}

function readText(root: string, file: string, issues: Issue[]): string | null {
  const abs = path.join(root, ...file.split('/'));
  let info;
  try {
    info = statSync(abs);
  } catch {
    push(issues, file, '', 'file not found');
    return null;
  }
  if (!info.isFile()) {
    push(issues, file, '', 'expected a file');
    return null;
  }
  return readFileSync(abs, 'utf8');
}

function isDirectory(abs: string): boolean {
  try {
    return statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function listSorted(abs: string): Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }> {
  return readdirSync(abs, { withFileTypes: true })
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name));
}
