/**
 * `view.json` (spec §7.2): the flat, UI-ready picture of one run that the daemon writes after
 * every transition. Panels and `bdc status` render only this. Words are for people (§9.1 rule 4):
 * no state ids, enums or file paths in the `*Words` fields.
 */
import { z } from 'zod';
import { Brief, Finding, Plan, Question, SpecComment } from './domain.js';

export const STAGES = ['intake', 'specDrafting', 'specReview', 'planning', 'planReview', 'building', 'finalReview', 'shipping', 'done', 'failed', 'cancelled'] as const;
export const Stage = z.enum(STAGES);
export type Stage = z.infer<typeof Stage>;

export const FindingView = Finding.extend({
  lens: z.string(),
  status: z.enum(['open', 'fixing', 'fixed', 'continued', 'overridden', 'advisory']),
  /** Why it was continued or overridden, and by whom. */
  note: z.string().default(''),
});
export type FindingView = z.infer<typeof FindingView>;

export const PhaseView = z.object({
  id: z.string(),
  title: z.string(),
  deps: z.array(z.string()),
  /** The phase machine's state id, for code. */
  state: z.string(),
  /** What it is doing, in words: "building 2 tasks", "waiting on you", "fixing SEC-1", "done". */
  words: z.string(),
  needsYou: z.boolean(),
  attemptsUsed: z.number().int(),
  findings: z.array(FindingView),
  verification: z
    .object({
      passed: z.boolean(),
      steps: z.array(z.object({ name: z.string(), command: z.string(), exitCode: z.number().nullable(), durationMs: z.number(), outputTail: z.string() })),
    })
    .nullable(),
  proof: z.array(z.object({ kind: z.string(), shows: z.string(), file: z.string().optional(), by: z.enum(['bdc', 'verifier', 'person']) })),
});
export type PhaseView = z.infer<typeof PhaseView>;

export const RunView = z.object({
  runId: z.string(),
  goal: z.string(),
  stage: Stage,
  /** The stepper label and what the run is doing, in words. */
  stageWords: z.string(),
  paused: z.boolean(),
  /** True when anything waits on the person: a question, an agent prompt, a review to approve. */
  needsYou: z.boolean(),
  error: z.string().nullable(),
  /** An `ask_user` call waiting for the person (§3.4): the question tool shows these. */
  asking: z.object({ askId: z.string(), scope: z.string().nullable(), questions: z.array(Question) }).nullable(),
  /** Trust / permission prompts from agents, answered with PROMPT_CHOICE. */
  agentPrompts: z.array(z.object({ agentKey: z.string(), prompt: z.string(), choices: z.array(z.string()) })),
  chat: z.array(z.object({ from: z.enum(['you', 'pm']), text: z.string() })),
  proposals: z.array(z.object({ id: z.string(), text: z.string() })),
  brief: Brief.nullable(),
  spec: z.object({ version: z.number().int(), markdown: z.string(), comments: z.array(SpecComment) }).nullable(),
  plan: Plan.nullable(),
  phases: z.array(PhaseView),
  pullRequest: z.object({ url: z.string().optional(), path: z.string().optional() }).nullable(),
});
export type RunView = z.infer<typeof RunView>;
