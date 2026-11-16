/**
 * Every event in the system (spec §5.6). Person events arrive over the daemon socket, so they
 * have zod schemas and are validated before reaching a machine. Internal events between actors
 * are plain types.
 */
import { z } from 'zod';
import { Answer, Blocker, Brief, Decision, Finding, Question, SpecComment } from './domain.js';

// ── Person → run (validated at the socket) ─────────────────────────────────────────────

export const PersonEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ROUND_ANSWERED'), answers: z.array(Answer) }),
  z.object({ type: z.literal('UNDERSTANDING_CONFIRMED'), corrections: z.string().optional() }),
  z.object({ type: z.literal('SKIP_QUESTIONS') }),
  z.object({ type: z.literal('SPEC_COMMENT'), comment: SpecComment.omit({ resolved: true }) }),
  z.object({ type: z.literal('SPEC_COMMENT_RESOLVED'), commentId: z.string().min(1) }),
  z.object({ type: z.literal('SPEC_CHANGES_REQUESTED'), note: z.string().optional() }),
  z.object({ type: z.literal('SPEC_APPROVED') }),
  z.object({ type: z.literal('PLAN_COMMENT'), phaseId: z.string().min(1), body: z.string().min(1) }),
  z.object({ type: z.literal('PLAN_CHANGES_REQUESTED'), note: z.string().optional() }),
  z.object({ type: z.literal('PLAN_EDITED'), planYaml: z.string().min(1) }),
  z.object({ type: z.literal('PLAN_APPROVED') }),
  z.object({ type: z.literal('MESSAGE'), text: z.string().min(1) }),
  /** Answers to an `ask_user` call that is waiting (§3.4). */
  z.object({ type: z.literal('ANSWER'), askId: z.string().min(1), answers: z.array(Answer) }),
  z.object({ type: z.literal('PROMPT_CHOICE'), agentKey: z.string().min(1), choice: z.string().min(1) }),
  z.object({ type: z.literal('APPLY_PROPOSAL'), proposalId: z.string().min(1) }),
  z.object({ type: z.literal('DISCARD_PROPOSAL'), proposalId: z.string().min(1) }),
  z.object({ type: z.literal('OVERRIDE'), phaseId: z.string().min(1), lens: z.string().optional(), reason: z.string().min(1) }),
  z.object({ type: z.literal('RETRY'), phaseId: z.string().optional() }),
  z.object({ type: z.literal('PAUSE') }),
  z.object({ type: z.literal('RESUME') }),
  z.object({ type: z.literal('CANCEL') }),
  z.object({ type: z.literal('OPEN_PR'), draft: z.boolean().default(true) }),
]);
export type PersonEvent = z.infer<typeof PersonEvent>;

// ── Agent actor (§5.5) ─────────────────────────────────────────────────────────────────

/** What one agent produced. `submission` is what its submit tool accepted (already validated). */
export type AgentOutcome =
  | { status: 'done'; submission: unknown }
  | { status: 'empty' | 'crashed' | 'timedOut' | 'failed'; detail: string };

/** Agent → its parent. Sent with `sendParent`; agents never end on their own (keepAlive or CLOSE). */
export type AgentToParent =
  | { type: 'AGENT_RESULT'; key: string; outcome: AgentOutcome }
  | { type: 'AGENT_NEEDS_YOU'; key: string; prompt: string; choices: string[] }
  | { type: 'AGENT_ASKING'; key: string; askId: string; questions: Question[] }
  | { type: 'AGENT_ASK_DONE'; key: string; askId: string };

/** Parent → agent. */
export type ParentToAgent =
  | { type: 'FOLLOW_UP'; prompt: string }
  | { type: 'PROMPT_CHOICE'; choice: string }
  | { type: 'CLOSE' };

/**
 * What the observer reports about a running agent (from `hc events` for its key, the MCP server
 * and the terminal's exit). `app` is the program that reported the status: `bdc` is the
 * adapter's launch marker, not the agent (the v1 pi bug).
 */
export type AgentObservation =
  | { type: 'OBS_STATUS'; app: string; state: string }
  | { type: 'OBS_SUBMITTED'; submission: unknown }
  | { type: 'OBS_ASKING'; askId: string; questions: Question[] }
  | { type: 'OBS_ASK_DONE'; askId: string }
  | { type: 'OBS_PROMPT'; prompt: string; choices: string[] }
  | { type: 'OBS_PROMPT_CLEARED' }
  | { type: 'OBS_EXITED'; code: number | null };

// ── Phase ↔ run (§5.3) ─────────────────────────────────────────────────────────────────

export type PhaseToRun =
  | { type: 'PHASE_VERIFY_SLOT_REQUEST'; phaseId: string }
  | { type: 'PHASE_VERIFY_SLOT_RELEASE'; phaseId: string }
  | { type: 'PHASE_NEEDS_PM'; phaseId: string; blocker: Blocker; attemptsUsed: number; attemptsMax: number }
  | { type: 'PHASE_DONE'; phaseId: string }
  | { type: 'PHASE_STOPPED'; phaseId: string; reason: string }
  | { type: 'PHASE_FINDINGS'; phaseId: string; lens: string; findings: Finding[] }
  | { type: 'AGENT_NEEDS_YOU'; key: string; prompt: string; choices: string[] };

export type RunToPhase =
  | { type: 'DEP_DONE'; phaseId: string }
  | { type: 'VERIFY_SLOT_GRANTED'; slot: number }
  | { type: 'PM_DECISION'; decision: Decision }
  | { type: 'PM_ASKING' }
  | { type: 'OVERRIDE'; lens?: string; reason: string; who: 'person' | 'pm' }
  | { type: 'RETRY' }
  | { type: 'PAUSE' }
  | { type: 'RESUME' }
  | { type: 'CANCEL' }
  | { type: 'PROMPT_CHOICE'; agentKey: string; choice: string };

// ── PM ↔ run (§5.4) ────────────────────────────────────────────────────────────────────

export type RunToPm =
  | { type: 'INTAKE'; goal: string }
  | { type: 'MESSAGE'; text: string }
  | { type: 'DECIDE'; scope: string; blocker: Blocker; fixAllowed: boolean }
  | { type: 'ANSWER'; askId: string; answers: Answer[] }
  | { type: 'CLOSE' };

export type PmToRun =
  | { type: 'PM_BRIEF'; brief: Brief }
  | { type: 'PM_REPLY'; text: string }
  | { type: 'PM_DECISION'; scope: string; decision: Decision }
  | { type: 'PM_ASKING'; scope: string | null; askId: string; questions: Question[] }
  | { type: 'PM_ASK_DONE'; askId: string }
  | { type: 'PM_PROPOSAL'; proposalId: string; text: string; event: PersonEvent }
  | { type: 'PM_FAILED'; detail: string };
