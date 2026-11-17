/**
 * The one way an agent's result enters bdc (spec §3.4): validate it against the schema of its kind
 * and append it to the job's inbox as one JSON line. `bdc mcp` (the MCP submit tool) and
 * `bdc submit` (for any CLI, and for tests) both call `submit`, so a submission is the same whether
 * the agent had MCP or only a shell.
 *
 * The job is named by the AGENT_ENV variables bdc starts every agent terminal with, never by the
 * agent: an agent cannot report on another agent's job, and its own prompt stays free of ids.
 */
import fs from 'node:fs';
import { AGENT_ENV, SUBMISSIONS, agentDir, inboxFile, type InboxEntry } from '../contracts/inbox.js';
import { SUBMIT_TOOLS, type SubmitKind } from '../contracts/actors.js';

/** Whose submission this is: the job's run, key and the submit kind its tool validates against. */
export interface SubmitEnv {
  root: string;
  run: string;
  key: string;
  kind: SubmitKind;
}

export type SubmitResult = { ok: true; seq: number } | { ok: false; problems: string[] };

/**
 * Validate `input` for `env.kind` and append it to the inbox. A rejected submission changes nothing
 * and answers with the problems, one line per issue, so the agent can fix the payload and call again.
 */
export function submit(env: SubmitEnv, input: unknown): SubmitResult {
  const parsed = SUBMISSIONS[env.kind].safeParse(input);
  if (!parsed.success) return { ok: false, problems: problemsOf(parsed.error) };

  const dir = agentDir(env.root, env.run, env.key);
  fs.mkdirSync(dir, { recursive: true });
  const file = inboxFile(dir);
  const entry: InboxEntry = { seq: lastSeq(file) + 1, at: new Date().toISOString(), kind: env.kind, submission: parsed.data };
  // One line, one write: the observer of the job reads whole lines, and a second writer (a retry, a
  // follow-up turn) cannot interleave its line into this one.
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  return { ok: true, seq: entry.seq };
}

/** The problems a model can act on: `path: message`, one per line, `(root)` when the whole payload is wrong. */
function problemsOf(error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string[] {
  return error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`);
}

/** The highest `seq` already in the inbox, so the next entry counts up from it. 0 when there is none. */
function lastSeq(file: string): number {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return 0;
  }
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isRecord(entry) && typeof entry.seq === 'number') return entry.seq;
    } catch {
      // A line torn by a crashed writer: skip it and count from the last good one.
    }
  }
  return 0;
}

/** The job the current process is an agent of, from the environment bdc started it with. */
export function envFromProcess(source: NodeJS.ProcessEnv = process.env): SubmitEnv {
  const read = (name: string): string => {
    const value = source[name];
    if (value === undefined || value === '') {
      throw new Error(
        `${name} is not set. bdc submit and bdc mcp only work inside an agent job, and bdc starts every ` +
          `agent with ${Object.values(AGENT_ENV).join(', ')}.`,
      );
    }
    return value;
  };
  const kind = read(AGENT_ENV.submit);
  if (!isSubmitKind(kind)) {
    throw new Error(`${AGENT_ENV.submit} is "${kind}", which is not a bdc submission kind (${Object.keys(SUBMIT_TOOLS).join(', ')}).`);
  }
  return { root: read(AGENT_ENV.root), run: read(AGENT_ENV.run), key: read(AGENT_ENV.key), kind };
}

export function isSubmitKind(value: string): value is SubmitKind {
  return Object.hasOwn(SUBMIT_TOOLS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
