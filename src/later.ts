/**
 * Phases this package does not implement. Pointers only — do not build them here.
 * The ids match docs/phases.yaml, minus p1-core.
 */
export const UNIMPLEMENTED_PHASES = [
  {
    id: 'p2-herdr-bridge',
    note: 'TODO(p2-herdr-bridge): Herdr socket client (agent.start, agent.prompt with wait), worktree per task, agent launcher from manifests and custom commands.',
  },
  {
    id: 'p3-spec-plan',
    note: 'TODO(p3-spec-plan): spec grill loop, comment replies, and the planner that writes phases.yaml.',
  },
  {
    id: 'p4-orchestrator',
    note: 'TODO(p4-orchestrator): DAG scheduler, env up/down, verify retries, reviewer fix loop, and the PM question queue.',
  },
  {
    id: 'p5-layout',
    note: 'TODO(p5-layout): Herdr mods for progress, spec review, the phase DAG, verification, reviewers, and the PM chat dock.',
  },
  {
    id: 'p6-pr-publish',
    note: 'TODO(p6-pr-publish): final review and verify, then open pr_targets with evidence. Publish the Herdr layout.',
  },
  {
    id: 'p7-hosted-readiness',
    note: 'TODO(p7-hosted-readiness): append-only event log, snapshots, and session export/import.',
  },
  {
    id: 'p8-hosted',
    note: 'TODO(p8-hosted): self-hosted Cloudflare Worker, Durable Object, D1, and R2. Not in this phase.',
  },
] as const;
