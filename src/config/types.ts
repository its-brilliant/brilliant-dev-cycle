export const BLOCK_ON = ['any', 'low', 'medium', 'high', 'none'] as const;
export type BlockOn = (typeof BLOCK_ON)[number];

export const SEVERITIES = ['low', 'medium', 'high'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Roles the orchestrator always needs. Extra roles are allowed. */
export const REQUIRED_ROLES = ['spec', 'planner', 'worker', 'pm', 'reviewer'] as const;

/**
 * A command the orchestrator can start without a Herdr manifest.
 * `herdr_manifest` is a manifest path, or null when the command stands alone.
 */
export interface AgentCommand {
  command: string;
  herdr_manifest: string | null;
}

/** A Herdr agent name, or an inline command. Names are resolved in a later phase. */
export type AgentRef = string | AgentCommand;

export interface AgentsConfig {
  default: string;
  roles: Record<string, AgentRef>;
  custom: Record<string, AgentCommand>;
}

export interface ReviewerConfig {
  block_on: BlockOn;
}

export interface GithubPrTarget {
  provider: 'github';
  repo: string;
  base: string;
  draft: boolean;
}

export interface GitlabPrTarget {
  provider: 'gitlab';
  project: string;
  base: string;
  draft: boolean;
}

export type PrTarget = GithubPrTarget | GitlabPrTarget;

export interface EnvConfig {
  up: string;
  down: string;
}

export interface RunCheck {
  kind: 'run';
  run: string;
}

export interface AgentCheck {
  kind: 'agent';
  agent: string;
}

export type VerifyCheck = RunCheck | AgentCheck;

export interface VerifyConfig {
  setup?: string;
  setup_md?: string;
  checks: VerifyCheck[];
  evidence: string[];
}

export interface BdcConfig {
  agents: AgentsConfig;
  concurrency: number;
  max_envs: number;
  max_attempts: number;
  reviewers: Record<string, ReviewerConfig>;
  keep_envs: boolean;
  pr_targets: PrTarget[];
  env?: EnvConfig;
  verify?: VerifyConfig;
}
