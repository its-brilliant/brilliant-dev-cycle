/**
 * Domain data shared by every module. Schemas are the source of truth; types are inferred.
 * Spec: docs/spec.md. Section numbers in comments refer to it.
 */
import { z } from 'zod';

/** §3.1 Roles. Every role's CLI and model is the person's choice. */
export const ROLES = ['pm', 'specWriter', 'planner', 'builder', 'reviewer', 'verifier'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const AgentChoice = z.object({
  /** CLI bdc has an adapter for. v2.0: claude, pi. */
  cli: z.string().min(1),
  /** Model id as that CLI takes it. Empty means the CLI's own default. */
  model: z.string().default(''),
});
export type AgentChoice = z.infer<typeof AgentChoice>;

export const Severity = z.enum(['low', 'medium', 'high', 'critical']);
export type Severity = z.infer<typeof Severity>;
export const BlockOn = z.enum(['low', 'medium', 'high', 'critical', 'none']);
export type BlockOn = z.infer<typeof BlockOn>;

/** §8 Review lenses. The prompt lives in a file (shared or project), not here. */
export const Lens = z.object({
  block_on: BlockOn.default('high'),
  runs: z.enum(['every-phase', 'matching-scope', 'final-only']).default('every-phase'),
  scope: z.array(z.string()).default([]),
  agent: AgentChoice.optional(),
});
export type Lens = z.infer<typeof Lens>;

/** §7.4 Verification setup, one per repo. */
const Step = z.object({ name: z.string().optional(), run: z.string().min(1) });
export const VerificationSetup = z.object({
  env: z.record(z.string(), z.string()).default({}),
  setup: z.array(Step).default([]),
  ready: z.object({ run: z.string().min(1), timeout: z.number().int().positive().default(120) }).optional(),
  checks: z.array(Step).default([]),
  teardown: z.array(Step).default([]),
  parallel: z.number().int().positive().default(1),
  timeout: z.number().int().positive().default(1800),
});
export type VerificationSetup = z.infer<typeof VerificationSetup>;

/** `bdc.yaml`. */
export const ProjectConfig = z.object({
  /** One choice per role, all required: a run cannot start until the person has chosen every role (§3.1). */
  agents: z.record(Role, AgentChoice),
  lenses: z.record(z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/), Lens).default({}),
  verification: VerificationSetup.nullable().default(null),
  concurrency: z.number().int().positive().default(3),
  max_attempts: z.number().int().positive().default(3),
  base: z.string().default('main'),
  pr_targets: z
    .array(z.discriminatedUnion('provider', [
      z.object({ provider: z.literal('file'), path: z.string().default('.herd/pull-request.md') }),
      z.object({ provider: z.literal('github'), repo: z.string().optional(), draft: z.boolean().default(true) }),
    ]))
    .default([{ provider: 'file', path: '.herd/pull-request.md' }]),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

/** §4.4.1 Proof a phase needs. */
export const ProofKind = z.enum(['tests', 'log', 'screenshot', 'e2e', 'recording', 'walkthrough', 'manual']);
export type ProofKind = z.infer<typeof ProofKind>;
export const ProofRequirement = z.object({ kind: ProofKind, shows: z.string().default('') });
export type ProofRequirement = z.infer<typeof ProofRequirement>;

export const Id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, numbers and dashes');

/** §4.3 The plan (`phases.yaml`), as `submit_plan` takes it. */
export const Task = z.object({
  id: Id,
  title: z.string().min(1),
  /** Paths (globs) the task expects to touch. Tasks of one phase must not overlap. */
  paths: z.array(z.string()).default([]),
});
export const PhaseCheck = z.union([
  z.object({ name: z.string().optional(), run: z.string().min(1) }),
  z.object({ name: z.string().optional(), agent: z.string().min(1) }),
]);
export const PlanPhase = z.object({
  id: Id,
  title: z.string().min(1),
  deps: z.array(Id).default([]),
  tasks: z.array(Task).min(1),
  checks: z.array(PhaseCheck).default([]),
  proof: z.array(ProofRequirement).min(1),
});
export type PlanPhase = z.infer<typeof PlanPhase>;
export const Plan = z.object({ phases: z.array(PlanPhase).min(1) });
export type Plan = z.infer<typeof Plan>;

/** §8 One finding from one lens. */
export const Finding = z.object({
  id: z.string().min(1),
  severity: Severity,
  summary: z.string().min(1),
  file: z.string().optional(),
  line: z.number().int().positive().optional(),
  fix: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;
export const Findings = z.object({ findings: z.array(Finding) });

/** §3.4 The question tool. */
export const Question = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().default(''),
  kind: z.enum(['single', 'multi', 'text', 'confirm']),
  options: z.array(z.object({ id: z.string().min(1), label: z.string().min(1), hint: z.string().optional() })).default([]),
  recommended: z.string().optional(),
  allowOther: z.boolean().default(true),
});
export type Question = z.infer<typeof Question>;
export const Answer = z.object({
  questionId: z.string().min(1),
  /** Option ids picked (single: one, multi: any, confirm: "yes" | "no"). */
  picked: z.array(z.string()).default([]),
  /** Typed answer (text kind, or Other…). */
  text: z.string().default(''),
  skipped: z.boolean().default(false),
});
export type Answer = z.infer<typeof Answer>;

/** §6 What the PM decides about a blocked phase. Asking happens inside the PM session through `ask_user`. */
export const Decision = z.discriminatedUnion('action', [
  z.object({ action: z.literal('fix'), reason: z.string().min(1), instructions: z.string().min(1), builder: z.string().optional() }),
  z.object({ action: z.literal('continue'), reason: z.string().min(1) }),
  z.object({ action: z.literal('stop'), reason: z.string().min(1) }),
]);
export type Decision = z.infer<typeof Decision>;

/** §5.3 Why a phase is in `deciding`. */
export const Blocker = z.object({
  kind: z.enum(['build', 'conflict', 'review', 'verify-setup', 'verify', 'proof']),
  summary: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});
export type Blocker = z.infer<typeof Blocker>;

/** §4.1 What intake hands to the spec writer. */
export const Brief = z.object({
  brief: z.string().min(1),
  decisions: z.array(z.object({ question: z.string(), answer: z.string() })).default([]),
  assumptions: z.array(z.string()).default([]),
});
export type Brief = z.infer<typeof Brief>;

/** §4.2 A comment anchored to quoted text in the rendered spec. */
export const SpecComment = z.object({
  id: z.string().min(1),
  quote: z.string().min(1),
  prefix: z.string().default(''),
  suffix: z.string().default(''),
  body: z.string().min(1),
  replyTo: z.string().optional(),
  resolved: z.boolean().default(false),
});
export type SpecComment = z.infer<typeof SpecComment>;
