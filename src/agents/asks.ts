/**
 * The question tool's hand-over, as files (spec §3.4). `ask_user` is not a blocking call: the PM
 * gives bdc its questions and ends its turn, and the person's answers come back to the PM as its
 * next message. Two files carry that for one job, next to its inbox (src/contracts/inbox.ts):
 *
 * - `asks.jsonl`: one JSON line per `ask_user` call the MCP server accepted, append-only, so the
 *   observer of the job can report each ask as `OBS_ASKING`;
 * - `asks-reported`: the highest ask number the observer already reported, so a restarted observer
 *   (a daemon crash, §5.7) does not report the same ask a second time.
 *
 * Ask ids count from 1 per job (`ask-1`, `ask-2`, …), so "the highest number reported" is enough to
 * say which asks are new.
 */
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Question } from '../contracts/domain.js';
import { agentDir } from '../contracts/inbox.js';

/** What an `ask_user` call takes: one to eight questions, each validated by the contract schema. */
export const ASK_INPUT = z.object({ questions: z.array(Question).min(1).max(8) });

/** One line of `asks.jsonl`. */
export const AskEntry = z.object({
  askId: z.string().min(1),
  at: z.string(),
  questions: z.array(Question),
});
export type AskEntry = z.infer<typeof AskEntry>;

/** Whose questions these are: the job's run and key, as the AGENT_ENV variables name them. */
export interface AskEnv {
  root: string;
  run: string;
  key: string;
}

export type AskResult = { ok: true; askId: string } | { ok: false; problems: string[] };

/** Append-only JSON lines of AskEntry. */
export function asksFile(dir: string): string {
  return path.join(dir, 'asks.jsonl');
}

/** The highest ask number the observer has already turned into OBS_ASKING. */
export function reportedFile(dir: string): string {
  return path.join(dir, 'asks-reported');
}

/** The number in an ask id (`ask-3` → 3), or 0 when it is not one of bdc's ask ids. */
export function askNumber(askId: string): number {
  const match = /^ask-(\d+)$/.exec(askId);
  const digits = match?.[1];
  return digits === undefined ? 0 : Number.parseInt(digits, 10);
}

/**
 * Validate an `ask_user` call and file its questions for the job. A rejected call writes nothing and
 * answers with the problems, one `path: message` line each, like a rejected submission.
 */
export function ask(env: AskEnv, input: unknown): AskResult {
  const parsed = ASK_INPUT.safeParse(input);
  if (!parsed.success) return { ok: false, problems: problemsOf(parsed.error) };

  const dir = agentDir(env.root, env.run, env.key);
  fs.mkdirSync(dir, { recursive: true });
  const file = asksFile(dir);
  const entry: AskEntry = {
    askId: `ask-${lastAskNumber(file) + 1}`,
    at: new Date().toISOString(),
    questions: parsed.data.questions,
  };
  // One line, one write: the observer reads whole lines, and two calls cannot interleave.
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return { ok: true, askId: entry.askId };
}

/** Every ask in the file, in order. A line a crashed writer tore is skipped, not fatal. */
export function readAsks(file: string): AskEntry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const entries: AskEntry[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      const parsed = AskEntry.safeParse(JSON.parse(line));
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // A torn line costs one ask that the next `ask_user` call writes again.
    }
  }
  return entries;
}

/** The highest ask number already reported for this job; 0 when nothing was reported yet. */
export function readReported(file: string): number {
  try {
    const number = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
    return Number.isFinite(number) && number > 0 ? number : 0;
  } catch {
    return 0;
  }
}

/** Remember that ask `number` was reported, so a restarted observer does not repeat it. */
export function writeReported(file: string, number: number): void {
  try {
    fs.writeFileSync(file, `${number}\n`);
  } catch {
    // The report is what matters; a lost number costs one duplicate after a restart.
  }
}

/** The highest ask number already in the file, so the next ask counts up from it. 0 when there is none. */
function lastAskNumber(file: string): number {
  const entries = readAsks(file);
  return entries.reduce((highest, entry) => Math.max(highest, askNumber(entry.askId)), 0);
}

/** The problems a model can act on: `path: message`, one per line, `(root)` when the whole input is wrong. */
function problemsOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}
