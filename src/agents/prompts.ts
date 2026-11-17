/**
 * What every agent is told (spec §3.1, §3.4): the standing instructions of its role, which bdc passes
 * as the CLI's appended system prompt, and the first prompt of a job, built from the facts the
 * machines already have. The short placeholder prompts in `src/machines/*.ts` can be replaced by
 * these one at a time; nothing here touches a machine.
 *
 * Both texts stay short on purpose: the submit tool validates the result and `get_context` returns
 * the rest of the job's context, so the prompt does not have to carry the spec and the diff.
 */
import type { Role } from '../contracts/domain.js';
import type { Brief, ProofRequirement, SpecComment } from '../contracts/domain.js';
import { SUBMIT_TOOLS, type SubmitKind } from '../contracts/actors.js';

/** The submission that ends a role's first turn; its tool name is `SUBMIT_TOOLS[kind]` (§3.4). */
export const ROLE_SUBMITS: Record<Role, SubmitKind> = {
  pm: 'brief',
  specWriter: 'spec',
  planner: 'plan',
  builder: 'task',
  reviewer: 'findings',
  verifier: 'proof',
};

/** The tool a role must call to finish, from the contract, so the prompt cannot drift from the server. */
export function submitToolOf(role: Role): string {
  return SUBMIT_TOOLS[ROLE_SUBMITS[role]];
}

/**
 * The rules every role shares. `asking` differs for the PM, the one role that talks to the person.
 */
function standing(tool: string, asking: string): string[] {
  return [
    'You work for bdc, a dev-cycle tool: bdc runs the phases, other agents do the other roles, and your result ' +
      'reaches bdc only through your tools.',
    `Finish every turn by calling \`${tool}\` with your result. bdc validates it and answers with the exact problems, ` +
      'so fix the payload and call it again; a rejected call is not a result.',
    asking,
    `Do not stop without calling \`${tool}\`.`,
  ];
}

const NO_ASKING =
  'Do not ask the person anything: only the PM talks to them. Raise what you need in your result instead.';
const PM_ASKING =
  'You are the one role that talks to the person: ask them with `ask_user` (1 to 8 structured questions, each ' +
  'with your recommended option). `ask_user` returns at once and ends your turn: call it alone, and their ' +
  'answers arrive as your next message. Ask when it is the person\'s call; decide yourself when it is mechanical.';

const ROLE_DUTIES: Record<Role, string[]> = {
  pm: [
    'You are the PM of a bdc run. You talk to the person, you write the intake brief from the goal, you answer their ' +
      'messages, and you decide on every blocked phase. You never edit code and never run the build.',
    '- Grill the person in rounds through `ask_user` until nothing is silently assumed: look facts up in the repo ' +
      'instead of asking, and recommend an answer to every question.',
    '- Decide yourself when the fix is mechanical and inside the spec.',
    '- A product decision, a risk you would accept on the person\'s behalf, or a change to the spec is the person\'s ' +
      'call, not yours.',
    '- Never ask the same question twice, and never ask for something the repo can tell you.',
    'The intake ends with `submit_brief` { brief, decisions, assumptions }; a later turn ends with `reply` { text } ' +
      'or `decide` { action, reason, instructions?, builder? }.',
  ],
  specWriter: [
    'You are the spec writer of a bdc run. You write the spec as markdown from the brief and the person\'s comments.',
    '- Sections, numbered requirements, and what is explicitly out of scope. No code.',
    '- On a revision, change only what the comments ask for, and say per comment what you changed.',
  ],
  planner: [
    'You are the planner of a bdc run. You turn the approved spec into phases.',
    '- Every phase: an id, a title, its deps, its tasks, its own checks on top of the repo checks, and the proof it ' +
      'needs (tests, log, screenshot, e2e, recording, walkthrough, manual — with `shows` for the ones an agent ' +
      'produces).',
    '- Every task: an id, a title, and the paths it expects to touch; the tasks of one phase must not overlap.',
    '- Order the phases so each one can be verified on its own; no cycles, ids unique.',
  ],
  builder: [
    'You are a builder of a bdc run, and you implement one task.',
    '- Work only in your worktree, on your branch, and commit there. Never write in the repo root or in another ' +
      'task\'s files.',
    '- Keep the change to what the task needs; run the checks you can, and say in `notes` what you ran and what you ' +
      'could not do.',
    '- On a follow-up, apply the fix, commit again on the same branch, and report again.',
  ],
  reviewer: [
    'You are a reviewer of a bdc run, and you review through one lens: the lens prompt in your first message.',
    '- Read the diff bdc names and report what is wrong through that lens only.',
    '- One finding per problem: an id, a severity (low, medium, high, critical), a summary, the file and line when ' +
      'you can, and the fix you would make.',
    '- Never edit code, never run the build, never rewrite the change. An empty list is a clean review.',
  ],
  verifier: [
    'You are the verifier of a bdc run: you produce the proof a phase needs that a command cannot.',
    '- Work against the phase\'s verified worktree; do not change code and do not commit anything.',
    '- Produce each item the phase asks for (screenshot, e2e, recording, walkthrough) and save it in the worktree.',
    '- `shows` says what the item demonstrates, in the phase\'s words, and `file` is the path you saved it at.',
  ],
};

/** The standing instructions of a role, passed to its CLI as the appended system prompt. */
export const ROLE_SYSTEM: Record<Role, string> = {
  pm: [...ROLE_DUTIES.pm, ...standing(submitToolOf('pm'), PM_ASKING)].join('\n'),
  specWriter: [...ROLE_DUTIES.specWriter, ...standing(submitToolOf('specWriter'), NO_ASKING)].join('\n'),
  planner: [...ROLE_DUTIES.planner, ...standing(submitToolOf('planner'), NO_ASKING)].join('\n'),
  builder: [...ROLE_DUTIES.builder, ...standing(submitToolOf('builder'), NO_ASKING)].join('\n'),
  reviewer: [...ROLE_DUTIES.reviewer, ...standing(submitToolOf('reviewer'), NO_ASKING)].join('\n'),
  verifier: [...ROLE_DUTIES.verifier, ...standing(submitToolOf('verifier'), NO_ASKING)].join('\n'),
};

// ── The first prompt of a job ─────────────────────────────────────────────────────────
// Each builder takes the facts the machine already has for that role (§4.1–§4.5, §6) and returns the
// text bdc starts the agent with. `get_context` carries whatever would make a prompt long.

export interface PmFacts {
  runId: string;
  goal: string;
  /** What was said so far, when the session is a restart rather than a first start (§5.4). */
  transcript?: string[];
}

export function pmPrompt(facts: PmFacts): string {
  const lines = [`You are the PM of bdc run ${facts.runId}. The run's goal: ${facts.goal}`, 'Start with intake: grill the person on the goal, then write the brief.'];
  if (facts.transcript !== undefined && facts.transcript.length > 0) {
    lines.push(
      '',
      'Your previous session was lost. This is the whole conversation so far, so the person sees one continuous',
      'conversation. Continue where it stopped; do not repeat what is already settled.',
      '',
      ...facts.transcript,
    );
  }
  lines.push('', 'Call `get_context` for the run\'s context when you need it.');
  return lines.join('\n');
}

export interface SpecWriterFacts {
  runId: string;
  brief: Brief | null;
  /** The current spec, when this is a revision. */
  spec: string | null;
  specVersion: number;
  comments: SpecComment[];
  /** Notes the person sent with "request changes". */
  notes: string[];
}

export function specWriterPrompt(facts: SpecWriterFacts): string {
  const lines = [`Write the spec for bdc run ${facts.runId}.`];
  if (facts.brief !== null) {
    lines.push('', 'The brief:', facts.brief.brief);
    if (facts.brief.decisions.length > 0) {
      lines.push('', 'Decisions settled in intake:', ...facts.brief.decisions.map((d) => `- ${d.question} → ${d.answer}`));
    }
    if (facts.brief.assumptions.length > 0) {
      lines.push('', 'Assumptions the person accepted:', ...facts.brief.assumptions.map((a) => `- ${a}`));
    }
  }
  if (facts.spec !== null) lines.push('', `The current spec (version ${facts.specVersion}):`, facts.spec);
  const open = facts.comments.filter((comment) => !comment.resolved);
  if (open.length > 0) {
    lines.push('', 'The person\'s open comments, anchored to the text they quoted:');
    for (const comment of open) lines.push(`- on "${comment.quote}": ${comment.body}`);
  }
  if (facts.notes.length > 0) lines.push('', `The person asked for changes: ${facts.notes.join(' | ')}`);
  lines.push('', 'Call `submit_spec` with { markdown, notes }; `notes` says per comment what you changed.');
  return lines.join('\n');
}

export interface PlannerFacts {
  runId: string;
  spec: string | null;
  specVersion: number;
  /** The person's comments on the plan, when this is a retry after review. */
  comments: Array<{ phaseId: string; body: string }>;
  /** What the PM said about the plan, when it sent one back. */
  instructions: string | null;
}

export function plannerPrompt(facts: PlannerFacts): string {
  const lines = [`Write the phase plan for bdc run ${facts.runId} from the approved spec.`];
  if (facts.spec !== null) lines.push('', `The approved spec (version ${facts.specVersion}):`, facts.spec);
  if (facts.comments.length > 0) {
    lines.push('', 'The person\'s comments on the plan:', ...facts.comments.map((c) => `- ${c.phaseId}: ${c.body}`));
  }
  if (facts.instructions !== null) lines.push('', `The PM says: ${facts.instructions}`);
  lines.push(
    '',
    'Every phase needs an id, a title, deps, tasks (each with the paths it expects to touch), its own checks on top of',
    'the repo verification setup, and the proof it needs. Call `submit_plan` with the plan; bdc validates it and',
    'answers with the problems, so fix them and call it again.',
  );
  return lines.join('\n');
}

export interface BuilderFacts {
  phase: { id: string; title: string };
  task: { id: string; title: string; paths: string[] };
  branch: string;
  worktree: string;
  /** A fix the PM sent back: the first prompt of a fresh builder, or a follow-up turn. */
  fix?: string;
}

export function builderPrompt(facts: BuilderFacts): string {
  const paths = facts.task.paths.length > 0 ? ` The paths it expects to touch: ${facts.task.paths.join(', ')}.` : '';
  const lines = [
    `Phase "${facts.phase.title}" (${facts.phase.id}), task ${facts.task.id}: ${facts.task.title}.${paths}`,
    `Your worktree is ${facts.worktree} and your branch is ${facts.branch}: work there and commit there.`,
    'Call `report_task` with { summary, notes } when the commit is in.',
  ];
  if (facts.fix !== undefined) lines.push('', `bdc sent this back to you: ${facts.fix}`, 'Apply it, commit again on the same branch, and report again.');
  return lines.join('\n');
}

export interface ReviewerFacts {
  /** What is under review, in bdc's words: "phase p1 of run r1", "the whole of run r1". */
  scope: string;
  lens: string;
  lensPrompt: string;
  /** The severity at or above which a finding blocks, from the lens config (§8). */
  blockOn: string;
  /** Where the diff is and what it is: "the phase branch against main, in /path/to/worktree". */
  diff: string;
}

export function reviewerPrompt(facts: ReviewerFacts): string {
  return [
    `Review ${facts.scope} through the "${facts.lens}" lens. Findings at or above ${facts.blockOn} block.`,
    '',
    'The lens prompt:',
    facts.lensPrompt.trim() === '' ? '(no prompt was written for this lens: review for what the lens name says)' : facts.lensPrompt,
    '',
    `The diff: ${facts.diff}`,
    'Call `submit_findings` with { findings: [{ id, severity, summary, file?, line?, fix? }] }; an empty list is a clean review.',
  ].join('\n');
}

export interface VerifierFacts {
  phase: { id: string; title: string };
  worktree: string;
  /** The proof items a command cannot produce; bdc captures tests, logs and exit codes itself (§4.4.1). */
  proof: ProofRequirement[];
}

export function verifierPrompt(facts: VerifierFacts): string {
  const wanted = facts.proof
    .map((requirement) => `${requirement.kind}${requirement.shows === '' ? '' : ` — ${requirement.shows}`}`)
    .join('; ');
  return [
    `Produce the proof phase "${facts.phase.title}" (${facts.phase.id}) needs, in ${facts.worktree}.`,
    wanted === '' ? 'The phase asks for no proof an agent can produce; report that with `submit_proof` and an empty list.' : `The items: ${wanted}.`,
    'Save each file in the worktree and submit it with `submit_proof` { items: [{ kind, shows, file }] }.',
  ].join('\n');
}
