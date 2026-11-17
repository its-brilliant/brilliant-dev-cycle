/**
 * runMachine (spec §5.2): one run, from the goal to an opened pull request.
 *
 * The run owns the PM session (`pm`) and the stage agents (spec writer, planner, final-review
 * lenses) and spawns one `phase` child per plan phase at Build. Those three child machines are
 * built by other slices; they are named actors here with throwing defaults, and the daemon wires
 * them with `machine.provide({ actors })` (§5.1). Every spawn is idempotent — an agent is spawned
 * only when it is not already up — so a restore (§5.7) and a resume (§4.7) never start a second
 * session for the same job.
 *
 * Pause uses a deep history state. XState records deep history when the state *containing* the
 * history node is exited and the root is never exited, so the stages live in the compound `active`
 * state next to the `resume` history node; `paused`, `done`, `failed` and `cancelled` are top-level
 * siblings. `RETRY` from `failed` targets the same history node, so it re-enters the stage that
 * failed, not the start of the run (§5.2).
 *
 * Results that arrive while the run is paused are held in `deferred` and replayed on RESUME, so a
 * phase or agent that finishes during a pause still moves the run when it resumes.
 *
 * v2.0 has no fix at run level (§4.5): the PM's decision on a blocking final review can only
 * continue (→ shipping) or stop (→ failed); a `fix` decision there is treated as a stop.
 *
 * `AGENT_NEEDS_YOU` arrives from any agent (a phase child forwards its own, the PM its session's)
 * and becomes a prompt card the person answers with `PROMPT_CHOICE`, which the run hands to whoever
 * holds that job key (§3.3). `PHASE_FINDINGS` is still deliberately ignored: a phase's findings
 * reach the run inside its blocker and its `PHASE_NEEDS_PM` (§5.3).
 */
import {
  assign,
  enqueueActions,
  fromCallback,
  fromPromise,
  setup,
  type AnyActorLogic,
  type EventObject,
} from 'xstate';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import {
  Findings,
  Plan,
  type AgentChoice,
  type Brief,
  type Decision,
  type Finding,
  type Lens,
  type PlanPhase,
  type ProjectConfig,
  type Question,
  type Severity,
  type SpecComment,
  type VerificationSetup,
} from '../contracts/domain.js';
import { PersonEvent, type AgentToParent, type PhaseToRun, type PmToRun } from '../contracts/events.js';
import type { AgentJob, EnsureWorktreeInput, EnsureWorktreeOutput } from '../contracts/actors.js';
import { answersInWords, pmMachine, type PmInput } from './pm.js';

export interface RunInput {
  runId: string;
  root: string;
  goal: string;
  config: ProjectConfig;
  /** The lens prompt text per lens name (§8): the machine cannot read files, the daemon resolves them. */
  lensPrompts: Record<string, string>;
}

/** What one phase child gets (§5.3). Built by the run so the phase never reads project config. */
export interface RunPhaseInput {
  runId: string;
  root: string;
  runBranch: string;
  runWorktree: string;
  phase: PlanPhase;
  lenses: Record<string, Lens & { prompt: string }>;
  agents: { builder: AgentChoice; reviewer: AgentChoice; verifier: AgentChoice };
  verification: VerificationSetup | null;
  maxAttempts: number;
  doneDeps: string[];
}

/** `openPullRequest` (§4.6): writes the PR body and opens it on every target. */
export interface OpenPullRequestInput {
  runId: string;
  root: string;
  runBranch: string;
  draft: boolean;
  prTargets: ProjectConfig['pr_targets'];
}
export interface OpenPullRequestOutput {
  url?: string;
  path?: string;
}

export type Stage =
  | 'intake'
  | 'specDrafting'
  | 'specReview'
  | 'planning'
  | 'planReview'
  | 'building'
  | 'finalReview'
  | 'shipping';

export type PhaseStatus = 'waiting' | 'active' | 'done' | 'stopped';

export interface ChatEntry {
  from: 'pm' | 'person';
  text: string;
  proposalId?: string;
}

export interface StageAgent {
  id: string;
  key: string;
}

interface RunContext {
  runId: string;
  root: string;
  goal: string;
  config: ProjectConfig;
  lensPrompts: Record<string, string>;
  runBranch: string;
  runWorktree: string;
  /** The stage the run is in, so `failed` can say where it failed (§5.2). */
  stage: Stage;
  brief: Brief | null;
  specVersion: number;
  spec: string | null;
  specNotes: string[];
  specComments: SpecComment[];
  plan: Plan | null;
  planHash: string;
  planAttempts: number;
  planComments: Array<{ phaseId: string; body: string }>;
  planInstructions: string | null;
  /** Stage agents that are up, by name (`spec`, `plan`, `review:<lens>`); cleared when they report. */
  stageAgents: Record<string, StageAgent>;
  stageSpawns: Record<string, number>;
  spawns: number;
  phases: Record<string, PhaseStatus>;
  /** `held[slot]` is the phase holding that verification slot, or `''` when the slot is free (§7.4). */
  verifySlots: { max: number; held: string[] };
  verifyQueue: string[];
  overrides: Array<{ phaseId: string; lens?: string; reason: string; who: 'person' | 'pm' }>;
  decisions: Array<{ scope: string; decision: Decision }>;
  reviewStarted: boolean;
  reviewPending: string[];
  reviewFindings: Record<string, Finding[]>;
  /** The `ask_user` call that is waiting for the person, with the questions it asked (§3.4, §7.2). */
  asking: { scope: string | null; askId: string; questions: Question[] } | null;
  /**
   * Trust and permission prompts of running agents, by the agent's job key (§3.3). A phase child
   * forwards its agents' prompts, the PM forwards its own; each is dropped when the person answers
   * it or when that agent moves on.
   */
  agentPrompts: Array<{ agentKey: string; prompt: string; choices: string[] }>;
  chat: ChatEntry[];
  proposals: Record<string, PersonEvent>;
  deferred: RunEvent[];
  error: { where: Stage | 'pm'; detail: string } | null;
  prDraft: boolean;
  pr: { url?: string; path?: string } | null;
}

type RunEvent =
  | PersonEvent
  | PhaseToRun
  | PmToRun
  | AgentToParent
  | { type: 'xstate.done.actor.openPullRequest'; output: OpenPullRequestOutput }
  | { type: 'xstate.error.actor.openPullRequest'; error: unknown };

/** A role that is not a builder gets 15 min per turn (§3.3). */
const STAGE_TIMEOUT_MS = 15 * 60 * 1000;

const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

const SpecSubmission = z.object({ markdown: z.string().min(1), notes: z.array(z.string()).default([]) });

/** A child machine the daemon wires (§5.1). Typed as any actor logic so `provide` can supply it. */
const notProvided = (name: string): AnyActorLogic =>
  // SAFETY: the slot must accept the real phase/agent machine or a test stub, whose context and
  // events differ from this placeholder's; nothing reads the placeholder's snapshot, it only throws.
  fromCallback<EventObject, unknown>(() => {
    throw new Error(`${name} not provided`);
  }) as unknown as AnyActorLogic;

// ── Names and pure helpers ─────────────────────────────────────────────────────────────

/** The child id of a plan phase: stable, so a restore re-attaches instead of spawning twice (§5.7). */
export function phaseChildId(phaseId: string): string {
  return `phase-${phaseId}`;
}

export function runBranchFor(runId: string): string {
  return `bdc/${runId}`;
}

export function runWorktreeFor(root: string, runId: string): string {
  return `${root}/.worktrees/bdc-${runId}`;
}

/** Lens config plus the prompt text, which is what a phase and a reviewer need (§8). */
export function lensInputs(config: ProjectConfig, lensPrompts: Record<string, string>): Record<string, Lens & { prompt: string }> {
  const lenses: Record<string, Lens & { prompt: string }> = {};
  for (const [name, lens] of Object.entries(config.lenses)) {
    lenses[name] = { ...lens, prompt: lensPrompts[name] ?? '' };
  }
  return lenses;
}

/** The lenses the final review runs: every lens that is not phase-scoped (§4.5). */
export function finalLenses(config: ProjectConfig): string[] {
  return Object.keys(config.lenses).filter((name) => config.lenses[name]?.runs !== 'matching-scope');
}

/** A plan as submitted, from YAML or already-parsed JSON; `null` when it is not a valid plan. */
export function parsePlan(value: unknown): Plan | null {
  let raw: unknown = value;
  if (typeof value === 'string') {
    try {
      raw = parseYaml(value);
    } catch {
      return null;
    }
  }
  const parsed = Plan.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** The guard behind `PLAN_EDITED`: the person's YAML must parse into a plan before it is accepted (§4.3). */
export function planYamlIsValid(planYaml: string): boolean {
  return parsePlan(planYaml) !== null;
}

/** Findings at or above a lens's `block_on`; these block the phase or the run (§8). */
export function blockingFindings(
  lenses: Record<string, Lens>,
  findings: Record<string, Finding[]>,
): Array<{ lens: string; finding: Finding }> {
  const blocking: Array<{ lens: string; finding: Finding }> = [];
  for (const [name, lens] of Object.entries(lenses)) {
    if (lens.block_on === 'none') continue;
    const floor = SEVERITY_RANK[lens.block_on];
    for (const finding of findings[name] ?? []) {
      if (SEVERITY_RANK[finding.severity] >= floor) blocking.push({ lens: name, finding });
    }
  }
  return blocking;
}

/** A short stable hash of the plan, so the run can say which plan the phases were built from. */
export function planHashOf(plan: Plan): string {
  const text = JSON.stringify(plan);
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The lowest free verification slot, or `null` when the repo's `parallel` are all busy (§7.4). */
function freeSlot(held: string[], max: number): number | null {
  for (let slot = 0; slot < max; slot += 1) {
    if (!held[slot]) return slot;
  }
  return null;
}

/** Writes `phaseId` into slot `slot`, keeping the array dense so it survives JSON (§5.7). */
function withSlot(held: string[], slot: number, phaseId: string): string[] {
  const next = [...held];
  while (next.length <= slot) next.push('');
  next[slot] = phaseId;
  return next;
}

/** Hands free verification slots to the phases waiting for one, lowest slot first (§7.4). */
function grantQueued(context: RunContext): { held: string[]; queue: string[]; grants: Array<{ phaseId: string; slot: number }> } {
  let held = [...context.verifySlots.held];
  const queue = [...context.verifyQueue];
  const grants: Array<{ phaseId: string; slot: number }> = [];
  for (;;) {
    const next = queue[0];
    if (next === undefined) break;
    if (context.phases[next] !== 'active') {
      queue.shift();
      continue;
    }
    const slot = freeSlot(held, context.verifySlots.max);
    if (slot === null) break;
    queue.shift();
    held = withSlot(held, slot, next);
    grants.push({ phaseId: next, slot });
  }
  return { held, queue, grants };
}

function outcomeDetail(outcome: AgentToParent extends never ? never : Extract<AgentToParent, { type: 'AGENT_RESULT' }>['outcome']): string {
  return outcome.status === 'done' ? 'the agent submitted a result the run could not use' : `${outcome.status}: ${outcome.detail}`;
}

/** The question round in the chat (§3.4, §9.4): one entry, the titles the person was asked. */
function questionsInChat(questions: Question[]): string {
  const titles = questions.map((question) => question.title);
  const [only] = titles;
  return titles.length === 1 && only !== undefined ? only : `${titles.length} questions: ${titles.join(' | ')}`;
}

/**
 * The phase a job key belongs to, or `null` when the key is not one of a phase's agents. Every key
 * the run makes starts with the run id and then names the phase or the stage (§5.3, §4.2).
 */
function phaseIdOfKey(context: RunContext, key: string): string | null {
  const [, scope] = key.split('/');
  return scope !== undefined && context.phases[scope] !== undefined ? scope : null;
}

/** The stage agent a reporting key belongs to, or `null` for a child that is not a stage agent. */
function stageNameForKey(context: RunContext, key: string): string | null {
  for (const [name, agent] of Object.entries(context.stageAgents)) {
    if (agent.key === key) return name;
  }
  return null;
}

function phaseInput(context: RunContext, phase: PlanPhase): RunPhaseInput {
  return {
    runId: context.runId,
    root: context.root,
    runBranch: context.runBranch,
    runWorktree: context.runWorktree,
    phase,
    lenses: lensInputs(context.config, context.lensPrompts),
    agents: {
      builder: context.config.agents.builder,
      reviewer: context.config.agents.reviewer,
      verifier: context.config.agents.verifier,
    },
    verification: context.config.verification,
    maxAttempts: context.config.max_attempts,
    doneDeps: phase.deps,
  };
}

/**
 * The next stage-agent child for `name`: a fresh child id and a key with a round suffix, so a second
 * round (a spec revision, a plan retry) is a new job, while a restore of the same round keeps the
 * same key and re-attaches instead of launching a second session (§3.2).
 */
function nextStageSpawn(
  context: Pick<RunContext, 'runId' | 'spawns' | 'stageSpawns' | 'stageAgents'>,
  name: string,
): { id: string; key: string; context: Pick<RunContext, 'spawns' | 'stageSpawns' | 'stageAgents'> } {
  const round = (context.stageSpawns[name] ?? 0) + 1;
  const spawns = context.spawns + 1;
  const key = `${context.runId}/${name}/${round}`;
  return {
    id: `agent-${spawns}`,
    key,
    context: {
      spawns,
      stageSpawns: { ...context.stageSpawns, [name]: round },
      stageAgents: { ...context.stageAgents, [name]: { id: `agent-${spawns}`, key } },
    },
  };
}

// ── Stage prompts (§4.1, §4.2, §4.3, §4.5) ─────────────────────────────────────────────

function specWriterPrompt(context: RunContext): string {
  const lines = [`Write the spec for bdc run ${context.runId}.`];
  if (context.brief) {
    lines.push('', 'The brief:', context.brief.brief);
    if (context.brief.decisions.length > 0) {
      lines.push('', 'Decisions settled in intake:', ...context.brief.decisions.map((decision) => `- ${decision.question} → ${decision.answer}`));
    }
    if (context.brief.assumptions.length > 0) {
      lines.push('', 'Assumptions the person accepted:', ...context.brief.assumptions.map((assumption) => `- ${assumption}`));
    }
  }
  if (context.spec !== null) {
    lines.push('', `The current spec (version ${context.specVersion}):`, context.spec);
  }
  const open = context.specComments.filter((comment) => !comment.resolved);
  if (open.length > 0) {
    lines.push('', 'The person\'s open comments, anchored to the text they quoted:');
    for (const comment of open) lines.push(`- on "${comment.quote}": ${comment.body}`);
  }
  if (context.specNotes.length > 0) {
    lines.push('', `The person asked for changes: ${context.specNotes.join(' | ')}`);
  }
  lines.push('', 'Call `submit_spec` with { markdown, notes }; `notes` says per comment what you changed.');
  return lines.join('\n');
}

function plannerPrompt(context: RunContext): string {
  const lines = [`Write the phase plan for bdc run ${context.runId} from the approved spec.`];
  if (context.spec !== null) lines.push('', `The approved spec (version ${context.specVersion}):`, context.spec);
  if (context.planComments.length > 0) {
    lines.push('', 'The person\'s comments on the plan:');
    for (const comment of context.planComments) lines.push(`- ${comment.phaseId}: ${comment.body}`);
  }
  if (context.planInstructions !== null) {
    lines.push('', `The PM says: ${context.planInstructions}`);
  }
  lines.push(
    '',
    'Every phase needs an id, a title, deps, tasks (each with the paths it expects to touch), its own',
    'checks on top of the repo verification setup, and the proof it needs.',
    'Call `submit_plan` with the plan; bdc validates it (schema, cycles, unique ids, disjoint task paths).',
  );
  return lines.join('\n');
}

function reviewerPrompt(context: RunContext, lens: string): string {
  const lensConfig = context.config.lenses[lens];
  return [
    `Review the whole of bdc run ${context.runId} through the "${lens}" lens.`,
    lensConfig ? `Findings at or above ${lensConfig.block_on} block.` : '',
    '',
    'The lens prompt:',
    context.lensPrompts[lens] ?? '(no prompt written for this lens yet)',
    '',
    'The diff is the run branch against the base branch. Call `submit_findings` with { findings: [{ id, severity, summary, file?, line?, fix? }] }.',
  ]
    .filter((line) => line !== '')
    .join('\n');
}

// ── The machine ────────────────────────────────────────────────────────────────────────

export const runMachine = setup({
  types: {
    context: {} as RunContext,
    events: {} as RunEvent,
    input: {} as RunInput,
  },
  actors: {
    // SAFETY: the slot is any actor logic so the daemon can provide a PM built with real effects;
    // this default is the real pmMachine, and the run only spawns it with a `PmInput`.
    pm: pmMachine as unknown as AnyActorLogic,
    phase: notProvided('phase'),
    agent: notProvided('agent'),
    ensureWorktree: fromPromise<EnsureWorktreeOutput, EnsureWorktreeInput>(() => {
      throw new Error('ensureWorktree not provided');
    }),
    openPullRequest: fromPromise<OpenPullRequestOutput, OpenPullRequestInput>(() => {
      throw new Error('openPullRequest not provided');
    }),
  },
  guards: {
    /** The person answered the ask that is waiting; an answer to another ask is not this one (§3.4). */
    answersAsking: ({ context, event }) =>
      context.asking !== null && (event.type === 'ROUND_ANSWERED' || (event.type === 'ANSWER' && event.askId === context.asking.askId)),
    /** A change request needs an open comment or a note (§4.2). */
    specChangesNeeded: ({ context, event }) =>
      event.type === 'SPEC_CHANGES_REQUESTED' &&
      (context.specComments.some((comment) => !comment.resolved) || (event.note ?? '').trim().length > 0),
    specSubmitted: ({ event }) =>
      event.type === 'AGENT_RESULT' && event.outcome.status === 'done' && SpecSubmission.safeParse(event.outcome.submission).success,
    planSubmitted: ({ event }) =>
      event.type === 'AGENT_RESULT' && event.outcome.status === 'done' && parsePlan(event.outcome.submission) !== null,
    /** The planner gets two retries before the PM is asked (§4.3). */
    plannerCanRetry: ({ context }) => context.planAttempts < 2,
    planFixDecided: ({ event }) => event.type === 'PM_DECISION' && event.decision.action === 'fix',
    planYamlValid: ({ event }) => event.type === 'PLAN_EDITED' && planYamlIsValid(event.planYaml),
    /** Every phase is done or stopped, so the final gate can look at the whole run. */
    allPhasesSettled: ({ context }) =>
      context.plan !== null &&
      context.plan.phases.every((phase) => {
        const status = context.phases[phase.id];
        return status === 'done' || status === 'stopped';
      }),
    reviewerSubmitted: ({ context, event }) =>
      event.type === 'AGENT_RESULT' &&
      event.outcome.status === 'done' &&
      (stageNameForKey(context, event.key)?.startsWith('review:') ?? false),
    finalReviewClean: ({ context }) =>
      context.reviewPending.length === 0 &&
      blockingFindings(context.config.lenses, context.reviewFindings).length === 0,
    runDecisionContinues: ({ event }) => event.type === 'PM_DECISION' && event.decision.action === 'continue',
    hasProposal: ({ context, event }) => event.type === 'APPLY_PROPOSAL' && context.proposals[event.proposalId] !== undefined,
  },
  actions: {
    // ── the PM ──────────────────────────────────────────────────────────────────────
    /** Spawns the PM session once and gives it the goal (§4.1). */
    startPm: enqueueActions(({ context, enqueue }) => {
      const input: PmInput = {
        runId: context.runId,
        root: context.root,
        agent: context.config.agents.pm,
        goal: context.goal,
      };
      enqueue.spawnChild('pm', { id: 'pm', input });
      enqueue.sendTo('pm', { type: 'INTAKE', goal: context.goal });
    }),
    messagePm: enqueueActions(({ event, enqueue }) => {
      if (event.type !== 'MESSAGE') return;
      enqueue.sendTo('pm', { type: 'MESSAGE', text: event.text });
    }),
    forwardRoundAnswers: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'ROUND_ANSWERED' || context.asking === null) return;
      enqueue.sendTo('pm', { type: 'ANSWER', askId: context.asking.askId, answers: event.answers });
    }),
    forwardAnswer: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'ANSWER' || context.asking === null || context.asking.askId !== event.askId) return;
      enqueue.sendTo('pm', { type: 'ANSWER', askId: event.askId, answers: event.answers });
    }),
    /** What the person answered, in the chat, in their own words (§7.2). */
    recordAnswers: assign({
      chat: ({ context, event }) => {
        if (event.type !== 'ROUND_ANSWERED' && event.type !== 'ANSWER') return context.chat;
        if (context.asking === null) return context.chat;
        return [...context.chat, { from: 'person', text: answersInWords(context.asking.questions, event.answers) }];
      },
    }),
    skipQuestions: enqueueActions(({ enqueue }) => {
      enqueue.sendTo('pm', { type: 'MESSAGE', text: 'The person skipped the rest of the questions. Write the brief now with what you have and list what you assumed.' });
    }),
    confirmUnderstanding: enqueueActions(({ event, enqueue }) => {
      if (event.type !== 'UNDERSTANDING_CONFIRMED') return;
      const corrections = (event.corrections ?? '').trim();
      enqueue.sendTo('pm', {
        type: 'MESSAGE',
        text: corrections.length > 0
          ? `The person confirmed the shared understanding with these corrections: ${corrections}. Write the brief now.`
          : 'The person confirmed the shared understanding. Write the brief now.',
      });
    }),
    storeBrief: assign({
      brief: ({ event }) => (event.type === 'PM_BRIEF' ? event.brief : null),
    }),
    recordAsking: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PM_ASKING') return;
      enqueue.assign({
        asking: { scope: event.scope, askId: event.askId, questions: event.questions },
        // The question round is part of the conversation the person sees (§3.4, §9.4).
        chat: [...context.chat, { from: 'pm' as const, text: questionsInChat(event.questions) }],
      });
      // A phase that raised the question waits for it (§5.3).
      if (event.scope !== null && context.phases[event.scope] === 'active') {
        enqueue.sendTo(phaseChildId(event.scope), { type: 'PM_ASKING' });
      }
    }),
    clearAsking: assign({ asking: null }),
    recordPmFailure: assign({
      error: ({ event }) => ({ where: 'pm' as const, detail: event.type === 'PM_FAILED' ? event.detail : 'the PM failed' }),
    }),
    appendReply: assign({
      chat: ({ context, event }) =>
        event.type === 'PM_REPLY' ? [...context.chat, { from: 'pm', text: event.text }] : context.chat,
    }),
    appendProposal: assign({
      chat: ({ context, event }) =>
        event.type === 'PM_PROPOSAL' ? [...context.chat, { from: 'pm', text: event.text, proposalId: event.proposalId }] : context.chat,
      proposals: ({ context, event }) =>
        event.type === 'PM_PROPOSAL' ? { ...context.proposals, [event.proposalId]: event.event } : context.proposals,
    }),
    /** Applying a proposal is the person sending the event it proposed (§4.7). */
    raiseProposal: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'APPLY_PROPOSAL') return;
      const proposed = context.proposals[event.proposalId];
      if (proposed === undefined) return;
      const proposals = { ...context.proposals };
      delete proposals[event.proposalId];
      enqueue.assign({ proposals });
      enqueue.raise(proposed);
    }),
    discardProposal: assign({
      proposals: ({ context, event }) => {
        if (event.type !== 'DISCARD_PROPOSAL') return context.proposals;
        const proposals = { ...context.proposals };
        delete proposals[event.proposalId];
        return proposals;
      },
    }),
    recordDecision: assign({
      decisions: ({ context, event }) =>
        event.type === 'PM_DECISION' ? [...context.decisions, { scope: event.scope, decision: event.decision }] : context.decisions,
      // A continue is an override with the reason that justifies it, and it goes in the PR (§6).
      overrides: ({ context, event }) =>
        event.type === 'PM_DECISION' && event.decision.action === 'continue'
          ? [...context.overrides, { phaseId: event.scope, reason: event.decision.reason, who: 'pm' as const }]
          : context.overrides,
    }),

    // ── stage agents ────────────────────────────────────────────────────────────────
    /** Spawns the spec writer unless it is already up: a restore or a resume must not start a second one. */
    spawnSpecWriter: enqueueActions(({ context, enqueue }) => {
      if (context.stageAgents.spec) return;
      const spawn = nextStageSpawn(context, 'spec');
      const job: AgentJob = {
        key: spawn.key,
        role: 'specWriter',
        agent: context.config.agents.specWriter,
        cwd: context.root,
        prompt: specWriterPrompt(context),
        submit: 'spec',
        timeoutMs: STAGE_TIMEOUT_MS,
        keepAlive: false,
        labels: { 'bdc.run': context.runId, 'bdc.role': 'specWriter', 'bdc.key': spawn.key },
      };
      enqueue.assign(spawn.context);
      enqueue.spawnChild('agent', { id: spawn.id, input: job });
    }),
    spawnPlanner: enqueueActions(({ context, enqueue }) => {
      if (context.stageAgents.plan) return;
      const spawn = nextStageSpawn(context, 'plan');
      const job: AgentJob = {
        key: spawn.key,
        role: 'planner',
        agent: context.config.agents.planner,
        cwd: context.root,
        prompt: plannerPrompt(context),
        submit: 'plan',
        timeoutMs: STAGE_TIMEOUT_MS,
        keepAlive: false,
        labels: { 'bdc.run': context.runId, 'bdc.role': 'planner', 'bdc.key': spawn.key },
      };
      enqueue.assign(spawn.context);
      enqueue.spawnChild('agent', { id: spawn.id, input: job });
    }),
    initFinalReview: assign(({ context }) => {
      if (context.reviewStarted) return {};
      return { reviewStarted: true, reviewPending: finalLenses(context.config) };
    }),
    /** One reviewer per final lens, in parallel (§4.5); a lens that already reported is not re-run. */
    spawnReviewers: enqueueActions(({ context, enqueue }) => {
      // One pass over the lenses, so every reviewer gets its own child id: the counters move as we go.
      const cursor = {
        runId: context.runId,
        spawns: context.spawns,
        stageSpawns: context.stageSpawns,
        stageAgents: context.stageAgents,
      };
      const jobs: Array<{ id: string; input: AgentJob }> = [];
      for (const lens of context.reviewPending) {
        const name = `review:${lens}`;
        if (cursor.stageAgents[name]) continue;
        const spawn = nextStageSpawn(cursor, name);
        cursor.spawns = spawn.context.spawns;
        cursor.stageSpawns = spawn.context.stageSpawns;
        cursor.stageAgents = spawn.context.stageAgents;
        jobs.push({
          id: spawn.id,
          input: {
            key: spawn.key,
            role: 'reviewer',
            agent: context.config.lenses[lens]?.agent ?? context.config.agents.reviewer,
            cwd: context.root,
            prompt: reviewerPrompt(context, lens),
            submit: 'findings',
            timeoutMs: STAGE_TIMEOUT_MS,
            keepAlive: false,
            labels: { 'bdc.run': context.runId, 'bdc.role': 'reviewer', 'bdc.key': spawn.key },
          },
        });
      }
      enqueue.assign({ spawns: cursor.spawns, stageSpawns: cursor.stageSpawns, stageAgents: cursor.stageAgents });
      for (const job of jobs) enqueue.spawnChild('agent', job);
    }),
    /**
     * A stage agent reported, so its slot is free again and the next round gets a new key; a prompt
     * it left behind is moot, because the agent has moved on (§3.3).
     */
    clearStageAgent: assign({
      stageAgents: ({ context, event }) => {
        if (event.type !== 'AGENT_RESULT') return context.stageAgents;
        const stageAgents = { ...context.stageAgents };
        for (const [name, agent] of Object.entries(stageAgents)) {
          if (agent.key === event.key) delete stageAgents[name];
        }
        return stageAgents;
      },
      agentPrompts: ({ context, event }) =>
        event.type === 'AGENT_RESULT'
          ? context.agentPrompts.filter((prompt) => prompt.agentKey !== event.key)
          : context.agentPrompts,
    }),
    recordPrepareFailure: assign({
      error: ({ context, event }) => {
        const error = (event as { error?: unknown }).error;
        const message = error instanceof Error ? error.message : String(error ?? 'unknown error');
        return { where: context.stage, detail: `could not set up the run branch: ${message}` };
      },
    }),
    recordAgentFailure: assign({
      error: ({ context, event }) => ({
        where: context.stage,
        detail: event.type === 'AGENT_RESULT' ? outcomeDetail(event.outcome) : 'the agent failed',
      }),
    }),

    // ── spec ────────────────────────────────────────────────────────────────────────
    stageIntake: assign({ stage: 'intake' }),
    stageSpecDrafting: assign({ stage: 'specDrafting' }),
    stageSpecReview: assign({ stage: 'specReview' }),
    stagePlanning: assign({ stage: 'planning' }),
    stagePlanReview: assign({ stage: 'planReview' }),
    stageBuilding: assign({ stage: 'building' }),
    stageFinalReview: assign({ stage: 'finalReview' }),
    stageShipping: assign({ stage: 'shipping' }),
    storeSpec: assign({
      spec: ({ event }) => (event.type === 'AGENT_RESULT' && event.outcome.status === 'done' ? SpecSubmission.parse(event.outcome.submission).markdown : null),
      specNotes: ({ event }) =>
        event.type === 'AGENT_RESULT' && event.outcome.status === 'done' ? SpecSubmission.parse(event.outcome.submission).notes : [],
      specVersion: ({ context }) => context.specVersion + 1,
    }),
    addSpecComment: assign({
      specComments: ({ context, event }) =>
        event.type === 'SPEC_COMMENT' ? [...context.specComments, { ...event.comment, resolved: false }] : context.specComments,
    }),
    resolveSpecComment: assign({
      specComments: ({ context, event }) =>
        event.type === 'SPEC_COMMENT_RESOLVED'
          ? context.specComments.map((comment) => (comment.id === event.commentId ? { ...comment, resolved: true } : comment))
          : context.specComments,
    }),
    recordSpecNote: assign({
      specNotes: ({ context, event }) =>
        event.type === 'SPEC_CHANGES_REQUESTED' && (event.note ?? '').trim().length > 0
          ? [...context.specNotes, (event.note ?? '').trim()]
          : context.specNotes,
    }),

    // ── plan ────────────────────────────────────────────────────────────────────────
    storePlan: assign({
      plan: ({ event }) => (event.type === 'AGENT_RESULT' && event.outcome.status === 'done' ? parsePlan(event.outcome.submission) : null),
      planHash: ({ event }) => {
        const plan = event.type === 'AGENT_RESULT' && event.outcome.status === 'done' ? parsePlan(event.outcome.submission) : null;
        return plan === null ? '' : planHashOf(plan);
      },
      planAttempts: 0,
      planComments: [],
      planInstructions: null,
    }),
    replacePlan: assign({
      plan: ({ event }) => (event.type === 'PLAN_EDITED' ? parsePlan(event.planYaml) : null),
      planHash: ({ event }) => {
        const plan = event.type === 'PLAN_EDITED' ? parsePlan(event.planYaml) : null;
        return plan === null ? '' : planHashOf(plan);
      },
    }),
    countPlanAttempt: assign({ planAttempts: ({ context }) => context.planAttempts + 1 }),
    resetPlanAttempts: assign({ planAttempts: 0 }),
    addPlanComment: assign({
      planComments: ({ context, event }) =>
        event.type === 'PLAN_COMMENT' ? [...context.planComments, { phaseId: event.phaseId, body: event.body }] : context.planComments,
    }),
    recordPlanNote: assign({
      planComments: ({ context, event }) =>
        event.type === 'PLAN_CHANGES_REQUESTED' && (event.note ?? '').trim().length > 0
          ? [...context.planComments, { phaseId: '*', body: (event.note ?? '').trim() }]
          : context.planComments,
    }),
    /** The planner could not produce a valid plan twice over: the PM decides (§4.3). */
    askPmAboutPlan: enqueueActions(({ context, enqueue }) => {
      enqueue.sendTo('pm', {
        type: 'DECIDE',
        scope: 'plan',
        blocker: {
          kind: 'build',
          summary: `the planner did not produce a valid plan after ${context.planAttempts} retries`,
          evidence: [],
        },
        fixAllowed: true,
      });
    }),
    failOnPlanDecision: assign({
      error: ({ event }) => ({
        where: 'planning' as const,
        detail: event.type === 'PM_DECISION' ? `the PM stopped the plan: ${event.decision.reason}` : 'the plan was not accepted',
      }),
    }),
    takePlanInstructions: assign({
      planInstructions: ({ event }) =>
        event.type === 'PM_DECISION' && event.decision.action === 'fix' ? event.decision.instructions : null,
    }),

    // ── build (§4.4) ────────────────────────────────────────────────────────────────
    /** Starts every phase as waiting, once: a resume or a retry keeps the progress it already has. */
    initPhases: assign(({ context }) => {
      if (context.plan === null || Object.keys(context.phases).length > 0) return {};
      const phases: Record<string, PhaseStatus> = {};
      for (const phase of context.plan.phases) phases[phase.id] = 'waiting';
      return {
        phases,
        verifySlots: { max: context.config.verification?.parallel ?? 1, held: [] },
        verifyQueue: [],
      };
    }),
    /** Spawns ready phases up to `concurrency`, and no more (§4.4). */
    schedulePhases: enqueueActions(({ context, enqueue }) => {
      if (context.plan === null) return;
      const phases = { ...context.phases };
      let active = Object.values(phases).filter((status) => status === 'active').length;
      const ready: Array<{ id: string; input: RunPhaseInput }> = [];
      for (const phase of context.plan.phases) {
        if (active >= context.config.concurrency) break;
        if (phases[phase.id] !== 'waiting') continue;
        if (!phase.deps.every((dep) => phases[dep] === 'done')) continue;
        phases[phase.id] = 'active';
        active += 1;
        ready.push({ id: phaseChildId(phase.id), input: phaseInput(context, phase) });
      }
      if (ready.length === 0) return;
      enqueue.assign({ phases });
      for (const spawn of ready) enqueue.spawnChild('phase', spawn);
    }),
    markPhaseDone: assign({
      phases: ({ context, event }) =>
        event.type === 'PHASE_DONE' ? { ...context.phases, [event.phaseId]: 'done' } : context.phases,
    }),
    markPhaseStopped: assign({
      phases: ({ context, event }) =>
        event.type === 'PHASE_STOPPED' ? { ...context.phases, [event.phaseId]: 'stopped' } : context.phases,
    }),
    /** A finished phase unblocks its dependants (§5.3). */
    broadcastDepDone: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PHASE_DONE') return;
      for (const [phaseId, status] of Object.entries(context.phases)) {
        if (status !== 'active') continue;
        enqueue.sendTo(phaseChildId(phaseId), { type: 'DEP_DONE', phaseId: event.phaseId });
      }
    }),
    askPmAboutPhase: enqueueActions(({ event, enqueue }) => {
      if (event.type !== 'PHASE_NEEDS_PM') return;
      enqueue.sendTo('pm', {
        type: 'DECIDE',
        scope: event.phaseId,
        blocker: event.blocker,
        // The last attempt may not be a fix: the PM can only ask, continue or stop (§5.3).
        fixAllowed: event.attemptsUsed < event.attemptsMax - 1,
      });
    }),
    decidePhase: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PM_DECISION' || context.phases[event.scope] !== 'active') return;
      enqueue.sendTo(phaseChildId(event.scope), { type: 'PM_DECISION', decision: event.decision });
    }),

    // ── verification slots (§7.4) ───────────────────────────────────────────────────
    requestSlot: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PHASE_VERIFY_SLOT_REQUEST') return;
      const { phaseId } = event;
      // A phase asks again when it is restored: it may have missed the grant, so say it again.
      const held = context.verifySlots.held.indexOf(phaseId);
      if (held >= 0) {
        enqueue.sendTo(phaseChildId(phaseId), { type: 'VERIFY_SLOT_GRANTED', slot: held });
        return;
      }
      if (context.verifyQueue.includes(phaseId)) return;
      const slot = freeSlot(context.verifySlots.held, context.verifySlots.max);
      if (slot === null) {
        enqueue.assign({ verifyQueue: [...context.verifyQueue, phaseId] });
        return;
      }
      enqueue.assign({ verifySlots: { ...context.verifySlots, held: withSlot(context.verifySlots.held, slot, phaseId) } });
      enqueue.sendTo(phaseChildId(phaseId), { type: 'VERIFY_SLOT_GRANTED', slot });
    }),
    /** Frees the phase's slot on release, done or stopped, then hands it to the next waiting phase. */
    releaseSlot: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PHASE_VERIFY_SLOT_RELEASE' && event.type !== 'PHASE_DONE' && event.type !== 'PHASE_STOPPED') return;
      const { phaseId } = event;
      const freed = {
        ...context,
        verifySlots: {
          ...context.verifySlots,
          held: context.verifySlots.held.map((held) => (held === phaseId ? '' : held)),
        },
        verifyQueue: context.verifyQueue.filter((queued) => queued !== phaseId),
      };
      const { held, queue, grants } = grantQueued(freed);
      enqueue.assign({ verifySlots: { ...freed.verifySlots, held }, verifyQueue: queue });
      for (const grant of grants) {
        enqueue.sendTo(phaseChildId(grant.phaseId), { type: 'VERIFY_SLOT_GRANTED', slot: grant.slot });
      }
    }),

    // ── person controls (§4.7) ──────────────────────────────────────────────────────
    recordOverride: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'OVERRIDE') return;
      enqueue.assign({
        overrides: [...context.overrides, { phaseId: event.phaseId, lens: event.lens, reason: event.reason, who: 'person' as const }],
      });
      if (context.phases[event.phaseId] === 'active') {
        enqueue.sendTo(phaseChildId(event.phaseId), { type: 'OVERRIDE', lens: event.lens, reason: event.reason, who: 'person' });
      }
    }),
    /** A trust or permission prompt from any agent: a phase child's, a stage agent's, the PM's (§3.3). */
    recordAgentPrompt: assign({
      agentPrompts: ({ context, event }) =>
        event.type === 'AGENT_NEEDS_YOU'
          ? [
              ...context.agentPrompts.filter((prompt) => prompt.agentKey !== event.key),
              { agentKey: event.key, prompt: event.prompt, choices: event.choices },
            ]
          : context.agentPrompts,
    }),
    /** Every prompt of a phase's agents goes when the phase settles: those sessions are closed. */
    clearPhasePrompts: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PHASE_DONE' && event.type !== 'PHASE_STOPPED') return;
      enqueue.assign({
        agentPrompts: context.agentPrompts.filter((prompt) => phaseIdOfKey(context, prompt.agentKey) !== event.phaseId),
      });
    }),
    /**
     * The person's answer to an agent prompt (§3.3). The choice goes to whoever holds that key: a
     * phase child routes it to its own agents, a stage agent has the key itself, and the PM checks
     * the key against its session before sending the keys.
     */
    promptChoice: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'PROMPT_CHOICE') return;
      enqueue.assign({ agentPrompts: context.agentPrompts.filter((prompt) => prompt.agentKey !== event.agentKey) });
      for (const [phaseId, status] of Object.entries(context.phases)) {
        if (status !== 'active') continue;
        enqueue.sendTo(phaseChildId(phaseId), { type: 'PROMPT_CHOICE', agentKey: event.agentKey, choice: event.choice });
      }
      const stage = Object.values(context.stageAgents).find((agent) => agent.key === event.agentKey);
      if (stage !== undefined) enqueue.sendTo(stage.id, { type: 'PROMPT_CHOICE', choice: event.choice });
      enqueue.sendTo('pm', { type: 'PROMPT_CHOICE', agentKey: event.agentKey, choice: event.choice });
    }),
    /**
     * The run is over, so no session is needed any more (§5.5): the PM and every stage agent still
     * on record are told to close, and the PM passes it on to its own agent. A stage agent that
     * already reported closed itself and is no longer on record, so nothing is sent to a stopped
     * actor.
     */
    closeAgents: enqueueActions(({ context, enqueue }) => {
      enqueue.sendTo('pm', { type: 'CLOSE' });
      for (const agent of Object.values(context.stageAgents)) enqueue.sendTo(agent.id, { type: 'CLOSE' });
      // Nothing is running any more, so no prompt can still be waiting for the person.
      enqueue.assign({ agentPrompts: [] });
    }),
    /** Cancel stops every phase child, which closes its own agents (§5.3). */
    cancelPhases: enqueueActions(({ context, enqueue }) => {
      for (const [phaseId, status] of Object.entries(context.phases)) {
        if (status !== 'active') continue;
        enqueue.sendTo(phaseChildId(phaseId), { type: 'CANCEL' });
      }
    }),
    pauseChildren: enqueueActions(({ context, enqueue }) => {
      for (const [phaseId, status] of Object.entries(context.phases)) {
        if (status !== 'active') continue;
        enqueue.sendTo(phaseChildId(phaseId), { type: 'PAUSE' });
      }
    }),
    resumeChildren: enqueueActions(({ context, enqueue }) => {
      for (const [phaseId, status] of Object.entries(context.phases)) {
        if (status !== 'active') continue;
        enqueue.sendTo(phaseChildId(phaseId), { type: 'RESUME' });
      }
    }),
    /** Nothing new starts while paused, so results that arrive then wait in `deferred` (§4.7). */
    deferEvent: assign({ deferred: ({ context, event }) => [...context.deferred, event] }),
    replayDeferred: enqueueActions(({ context, enqueue }) => {
      for (const held of context.deferred) enqueue.raise(held);
      enqueue.assign({ deferred: [] });
    }),

    // ── final review and ship (§4.5, §4.6) ──────────────────────────────────────────
    storeFindings: enqueueActions(({ context, event, enqueue }) => {
      if (event.type !== 'AGENT_RESULT' || event.outcome.status !== 'done') return;
      const name = stageNameForKey(context, event.key);
      if (name === null || !name.startsWith('review:')) return;
      const lens = name.slice('review:'.length);
      const parsed = Findings.safeParse(event.outcome.submission);
      enqueue.assign({
        reviewFindings: { ...context.reviewFindings, [lens]: parsed.success ? parsed.data.findings : [] },
        reviewPending: context.reviewPending.filter((pending) => pending !== lens),
      });
    }),
    /** Blocking findings at run level go to the PM, which can only continue or stop (§4.5). */
    askPmIfBlocked: enqueueActions(({ context, enqueue }) => {
      if (context.reviewPending.length > 0) return;
      const blocking = blockingFindings(context.config.lenses, context.reviewFindings);
      if (blocking.length === 0) return;
      enqueue.sendTo('pm', {
        type: 'DECIDE',
        scope: 'run',
        blocker: {
          kind: 'review',
          summary: `${blocking.length} finding(s) block the run`,
          evidence: blocking.map(({ lens, finding }) => `${lens}: ${finding.severity} ${finding.summary}`),
        },
        fixAllowed: false,
      });
    }),
    failOnRunDecision: assign({
      error: ({ event }) => ({
        where: 'finalReview' as const,
        detail: event.type === 'PM_DECISION' ? `the PM stopped the run: ${event.decision.reason}` : 'the run was not accepted',
      }),
    }),
    rememberPrDraft: assign({
      prDraft: ({ event }) => (event.type === 'OPEN_PR' ? event.draft : true),
    }),
    storePr: assign({
      pr: ({ event }) => (event.type === 'xstate.done.actor.openPullRequest' ? { url: event.output.url, path: event.output.path } : null),
    }),
    recordPrFailure: assign({
      error: ({ event }) => ({
        where: 'shipping' as const,
        detail: event.type === 'xstate.error.actor.openPullRequest' ? String(event.error) : 'opening the pull request failed',
      }),
    }),
  },
}).createMachine({
  id: 'run',
  context: ({ input }) => ({
    runId: input.runId,
    root: input.root,
    goal: input.goal,
    config: input.config,
    lensPrompts: input.lensPrompts,
    runBranch: runBranchFor(input.runId),
    runWorktree: runWorktreeFor(input.root, input.runId),
    stage: 'intake',
    brief: null,
    specVersion: 0,
    spec: null,
    specNotes: [],
    specComments: [],
    plan: null,
    planHash: '',
    planAttempts: 0,
    planComments: [],
    planInstructions: null,
    stageAgents: {},
    stageSpawns: {},
    spawns: 0,
    phases: {},
    verifySlots: { max: 1, held: [] },
    verifyQueue: [],
    overrides: [],
    decisions: [],
    reviewStarted: false,
    reviewPending: [],
    reviewFindings: {},
    asking: null,
    agentPrompts: [],
    chat: [],
    proposals: {},
    deferred: [],
    error: null,
    prDraft: true,
    pr: null,
  }),
  entry: 'startPm',
  initial: 'active',
  // The person can talk to the PM, apply a proposal, pause or cancel in every non-final state (§4.7).
  // States that need something else for one of these override it below.
  on: {
    MESSAGE: { actions: 'messagePm' },
    PM_REPLY: { actions: 'appendReply' },
    PM_PROPOSAL: { actions: 'appendProposal' },
    PM_ASKING: { actions: 'recordAsking' },
    PM_ASK_DONE: { actions: 'clearAsking' },
    PM_FAILED: { target: '#run.failed', actions: 'recordPmFailure' },
    APPLY_PROPOSAL: [{ guard: 'hasProposal', actions: 'raiseProposal' }],
    DISCARD_PROPOSAL: { actions: 'discardProposal' },
    PROMPT_CHOICE: { actions: 'promptChoice' },
    AGENT_NEEDS_YOU: { actions: 'recordAgentPrompt' },
    OVERRIDE: { actions: 'recordOverride' },
    PM_DECISION: { actions: 'recordDecision' },
    // The person's answer to an ask (§3.4) belongs to the PM wherever the run is: the PM asks inside
    // its own turn, at intake or on a blocked phase (§6). An answer to no ask is ignored.
    ROUND_ANSWERED: [{ guard: 'answersAsking', actions: ['recordAnswers', 'forwardRoundAnswers'] }],
    ANSWER: [{ guard: 'answersAsking', actions: ['recordAnswers', 'forwardAnswer'] }],
    PAUSE: { target: '#run.paused', actions: 'pauseChildren' },
    CANCEL: { target: '#run.cancelled' },
  },
  states: {
    active: {
      initial: 'intake',
      states: {
        // ── intake: the PM grills the person (§4.1) ──────────────────────────────────
        intake: {
          entry: 'stageIntake',
          on: {
            SKIP_QUESTIONS: { actions: 'skipQuestions' },
            UNDERSTANDING_CONFIRMED: { actions: 'confirmUnderstanding' },
            PM_BRIEF: { target: '#run.active.specDrafting', actions: 'storeBrief' },
          },
        },

        // ── spec drafting → spec review (§4.2) ───────────────────────────────────────
        specDrafting: {
          entry: ['stageSpecDrafting', 'spawnSpecWriter'],
          on: {
            AGENT_RESULT: [
              { guard: 'specSubmitted', target: '#run.active.specReview', actions: ['storeSpec', 'clearStageAgent'] },
              { target: '#run.failed', actions: ['clearStageAgent', 'recordAgentFailure'] },
            ],
          },
        },
        specReview: {
          entry: 'stageSpecReview',
          on: {
            SPEC_COMMENT: { actions: 'addSpecComment' },
            SPEC_COMMENT_RESOLVED: { actions: 'resolveSpecComment' },
            SPEC_CHANGES_REQUESTED: [{ guard: 'specChangesNeeded', target: '#run.active.specDrafting', actions: 'recordSpecNote' }],
            SPEC_APPROVED: { target: '#run.active.planning' },
          },
        },

        // ── planning → plan review (§4.3) ────────────────────────────────────────────
        planning: {
          entry: ['stagePlanning', 'spawnPlanner'],
          on: {
            AGENT_RESULT: [
              { guard: 'planSubmitted', target: '#run.active.planReview', actions: ['storePlan', 'clearStageAgent'] },
              { guard: 'plannerCanRetry', target: 'planning', reenter: true, actions: ['clearStageAgent', 'countPlanAttempt'] },
              { actions: ['clearStageAgent', 'recordAgentFailure', 'askPmAboutPlan'] },
            ],
            PM_DECISION: [
              { guard: 'planFixDecided', target: 'planning', reenter: true, actions: ['recordDecision', 'resetPlanAttempts', 'takePlanInstructions'] },
              { target: '#run.failed', actions: ['recordDecision', 'failOnPlanDecision'] },
            ],
          },
        },
        planReview: {
          entry: 'stagePlanReview',
          on: {
            PLAN_COMMENT: { actions: 'addPlanComment' },
            PLAN_CHANGES_REQUESTED: { target: '#run.active.planning', actions: 'recordPlanNote' },
            PLAN_EDITED: [{ guard: 'planYamlValid', actions: 'replacePlan' }],
            PLAN_APPROVED: { target: '#run.active.building' },
          },
        },

        // ── build: phases as a DAG (§4.4) ────────────────────────────────────────────
        building: {
          entry: 'stageBuilding',
          initial: 'preparing',
          states: {
            // The run branch and its worktree come first: every phase branches from it and merges into it (§7.3).
            preparing: {
              invoke: {
                src: 'ensureWorktree',
                input: ({ context }) => ({ root: context.root, branch: runBranchFor(context.runId), base: context.config.base }),
                onDone: { target: 'phases' },
                onError: { target: '#run.failed', actions: 'recordPrepareFailure' },
              },
            },
            phases: {
              entry: ['initPhases', 'schedulePhases'],
              always: [{ guard: 'allPhasesSettled', target: '#run.active.finalReview' }],
            },
          },
          on: {
            PHASE_DONE: { actions: ['markPhaseDone', 'releaseSlot', 'schedulePhases', 'broadcastDepDone', 'clearPhasePrompts'] },
            PHASE_STOPPED: { actions: ['markPhaseStopped', 'releaseSlot', 'schedulePhases', 'clearPhasePrompts'] },
            PHASE_NEEDS_PM: { actions: 'askPmAboutPhase' },
            PHASE_VERIFY_SLOT_REQUEST: { actions: 'requestSlot' },
            PHASE_VERIFY_SLOT_RELEASE: { actions: 'releaseSlot' },
            PM_DECISION: { actions: ['recordDecision', 'decidePhase'] },
            PM_ASKING: { actions: 'recordAsking' },
          },
        },

        // ── final review: the lenses over the whole run (§4.5) ───────────────────────
        finalReview: {
          entry: ['stageFinalReview', 'initFinalReview', 'spawnReviewers'],
          always: [{ guard: 'finalReviewClean', target: '#run.active.shipping' }],
          on: {
            AGENT_RESULT: [
              { guard: 'reviewerSubmitted', actions: ['storeFindings', 'clearStageAgent', 'askPmIfBlocked'] },
              { target: '#run.failed', actions: ['clearStageAgent', 'recordAgentFailure'] },
            ],
            PM_DECISION: [
              { guard: 'runDecisionContinues', target: '#run.active.shipping', actions: 'recordDecision' },
              // v2.0 has no fix at run level, so anything but continue is a stop (§4.5).
              { target: '#run.failed', actions: ['recordDecision', 'failOnRunDecision'] },
            ],
          },
        },

        // ── ship (§4.6) ──────────────────────────────────────────────────────────────
        shipping: {
          entry: 'stageShipping',
          initial: 'ready',
          states: {
            ready: {
              on: {
                OPEN_PR: { target: 'opening', actions: 'rememberPrDraft' },
              },
            },
            opening: {
              invoke: {
                id: 'openPullRequest',
                src: 'openPullRequest',
                input: ({ context }) => ({
                  runId: context.runId,
                  root: context.root,
                  runBranch: context.runBranch,
                  draft: context.prDraft,
                  prTargets: context.config.pr_targets,
                }),
                onDone: { target: '#run.done', actions: 'storePr' },
                onError: { target: '#run.failed', actions: 'recordPrFailure' },
              },
            },
          },
        },

        // The deep history node RESUME and RETRY go back through (§5.2).
        resume: { type: 'history', history: 'deep' },
      },
    },

    paused: {
      entry: 'pauseChildren',
      on: {
        RESUME: { target: '#run.active.resume', actions: ['resumeChildren', 'replayDeferred'] },
        CANCEL: { target: '#run.cancelled' },
        PAUSE: {},
        // Results that arrive while paused are held, not lost (§4.7).
        PHASE_DONE: { actions: 'deferEvent' },
        PHASE_STOPPED: { actions: 'deferEvent' },
        PHASE_NEEDS_PM: { actions: 'deferEvent' },
        PHASE_VERIFY_SLOT_REQUEST: { actions: 'deferEvent' },
        PHASE_VERIFY_SLOT_RELEASE: { actions: 'deferEvent' },
        PHASE_FINDINGS: { actions: 'deferEvent' },
        AGENT_RESULT: { actions: 'deferEvent' },
        AGENT_ASKING: { actions: 'deferEvent' },
        AGENT_ASK_DONE: { actions: 'deferEvent' },
        AGENT_NEEDS_YOU: { actions: 'deferEvent' },
        PM_BRIEF: { actions: 'deferEvent' },
        PM_DECISION: { actions: 'deferEvent' },
      },
    },

    /** The run is finished: the pull request is opened, so every terminal goes (§5.5). */
    done: { id: 'run.done', type: 'final', entry: 'closeAgents' },

    /**
     * Nothing is closed here on purpose: `failed` is not final, and RETRY re-enters the stage that
     * failed, which re-attaches to the sessions by `bdc.key` (§3.2, §5.7). Closing them would leave
     * a retried run with dead terminals. A run the person gives up on is cancelled, and that closes
     * everything (§5.5).
     */
    failed: {
      id: 'run.failed',
      on: {
        // Back into the stage that failed, which is where the history node points (§5.2).
        RETRY: { target: '#run.active.resume' },
      },
    },

    /** Cancelled closes every terminal it still has, phases included (§5.5). */
    cancelled: { id: 'run.cancelled', type: 'final', entry: ['cancelPhases', 'closeAgents'] },
  },
});
