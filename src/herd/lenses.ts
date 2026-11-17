/**
 * Review lens prompts (spec §8, agreed 16 Nov): the person writes one prompt per lens, shared by
 * every project, and a project may keep its own copy.
 *
 * Shared prompts live in `BDC_HOME/reviewers/<lens>.md` (default `~/.config/bdc/reviewers/`), the
 * project's own copy in `<root>/.herd/reviewers/<lens>.md`. The project copy wins; when neither
 * exists the lens still runs, with a short built-in prompt, so a new project can review on day one
 * and the Reviewers screen has something to edit instead of an empty box.
 *
 * `lensPrompts` is what `ProjectRuns` hands the run machine as `lensPrompts` (§5.2): the machine
 * cannot read files, so every prompt is resolved here, once, before the run starts.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LensPrompt } from '../contracts/actors.js';

/** §8 lens names: the same rule `bdc.yaml` uses for a lens key, so a file name is always a name. */
export const LENS_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** `process.env`, or any slice of it: tests pass their own so the real `~/.config/bdc` is never read. */
export type Env = Record<string, string | undefined>;

export type LensScope = 'shared' | 'project';

/** `BDC_HOME`, or `~/.config/bdc` (§8). Resolved, so every path this module returns is absolute. */
export function bdcHome(env: Env = process.env): string {
  const configured = env['BDC_HOME'];
  return configured === undefined || configured.trim() === ''
    ? path.join(os.homedir(), '.config', 'bdc')
    : path.resolve(configured);
}

/** `<home>/reviewers/<lens>.md`: the prompt every project shares. */
export function sharedLensFile(name: string, env: Env = process.env): string {
  return path.join(bdcHome(env), 'reviewers', `${assertLensName(name)}.md`);
}

/** `<root>/.herd/reviewers/<lens>.md`: this project's own copy, which wins over the shared one. */
export function projectLensFile(root: string, name: string): string {
  return path.join(root, '.herd', 'reviewers', `${assertLensName(name)}.md`);
}

/** A lens name becomes a file name, so it is checked before it is ever used as one. */
export function assertLensName(name: string): string {
  if (!LENS_NAME.test(name)) {
    throw new Error(
      `not a lens name: ${JSON.stringify(name)} — use lowercase letters, numbers and dashes, starting with a letter or number (40 at most)`,
    );
  }
  return name;
}

/** The prompt a lens runs with: the project copy, else the shared one, else the built-in default. */
export function resolveLens(root: string, name: string, env: Env = process.env): LensPrompt {
  const project = readPrompt(projectLensFile(root, name));
  if (project !== null) return { name, text: project, source: 'project' };
  const shared = readPrompt(sharedLensFile(name, env));
  if (shared !== null) return { name, text: shared, source: 'shared' };
  return { name, text: defaultPrompt(name), source: 'default' };
}

/** The prompt text per lens name, which is what the run machine's `lensPrompts` input takes (§5.2). */
export function lensPrompts(root: string, names: string[], env: Env = process.env): Record<string, string> {
  const prompts: Record<string, string> = {};
  for (const name of names) prompts[name] = resolveLens(root, name, env).text;
  return prompts;
}

/** Writes a lens prompt where the Reviewers screen asked for it; answers the file it wrote. */
export function writeLens(root: string, name: string, text: string, scope: LensScope, env: Env = process.env): string {
  const file = scope === 'shared' ? sharedLensFile(name, env) : projectLensFile(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`);
  return file;
}

/** "Save as shared" (§8): this project's copy becomes the shared prompt, and the copy goes away. */
export function shareLens(root: string, name: string, env: Env = process.env): string {
  const project = projectLensFile(root, name);
  const text = readPrompt(project);
  if (text === null) throw new Error(`this project has no copy of the ${name} lens to share`);
  const file = writeLens(root, name, text, 'shared', env);
  fs.rmSync(project, { force: true });
  return file;
}

/** "Keep a project copy" (§8): the shared prompt is copied into the project, which may then edit it. */
export function localizeLens(root: string, name: string, env: Env = process.env): string {
  const text = readPrompt(sharedLensFile(name, env));
  if (text === null) throw new Error(`there is no shared prompt for the ${name} lens to copy`);
  return writeLens(root, name, text, 'project', env);
}

/** The prompt in a file, or null when there is no file or it is blank: a blank prompt is no prompt. */
function readPrompt(file: string): string | null {
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() === '' ? null : text;
  } catch {
    return null;
  }
}

/**
 * The prompts a lens gets before the person has written one. Short on purpose: they say what to
 * look for and what a finding must carry, and nothing about how bdc runs, because they are pasted
 * into a reviewer's job prompt as it is (`reviewerJob` in src/machines/phase.ts).
 */
const DEFAULTS: Record<string, string> = {
  security: [
    'You review this change for security problems, and nothing else.',
    '',
    'Look for: secrets or credentials in code, logs or fixtures; input that reaches a shell, SQL, a file path or HTML without being checked; a check that can be skipped (missing authorisation, a boundary crossed); data sent somewhere nobody asked for; a dependency added for something trivial.',
    '',
    'Report a finding only when you can point at the code and say what an attacker gains. Give each finding a severity (low, medium, high, critical), the file and line, and the smallest fix that closes it. Report nothing when the change is fine.',
  ].join('\n'),
  perf: [
    'You review this change for performance problems, and nothing else.',
    '',
    'Look for: work done per item that could be done once; a query, request or file read inside a loop; a whole table or file read when a part is needed; lists, caches or logs that grow without a limit; waiting that could happen at the same time.',
    '',
    'Report a finding only when you can say what it costs (how much work, how often, on what size of input) and the smallest change that removes the cost. Give each finding a severity (low, medium, high, critical) and the file and line. Report nothing when the change is fine.',
  ].join('\n'),
  ux: [
    'You review this change for how it feels to use, and nothing else.',
    '',
    'Look for: a control that does nothing, or does something other than what its label says; a state a person can reach with no way out; an error in the code\'s words instead of the person\'s; a wait with no sign that something is happening; text that names the implementation instead of the thing.',
    '',
    'Report a finding when a person would be stuck, surprised or misled, and say what they would see instead. Give each finding a severity (low, medium, high, critical) and the file and line. Report nothing when the change is fine.',
  ].join('\n'),
};

/** The default prompt for any lens, named so the person can tell which lens wrote the finding. */
export function defaultPrompt(name: string): string {
  const known = DEFAULTS[name];
  if (known !== undefined) return known;
  return [
    `You review this change through the "${name}" lens, and nothing else.`,
    '',
    `Read the spec and the diff, then report what this change gets wrong about ${name} — not what you would have built differently.`,
    '',
    'For each finding: the file and line, a severity (low, medium, high, critical), one sentence on what is wrong, and the smallest fix. Report nothing when the change is fine.',
  ].join('\n');
}
