import { expectEnum, expectId, expectInt, expectRecord, expectString, hasOwn, unknownFields } from '../fields.js';
import { got, push, type Issue } from '../issues.js';
import { parseYaml } from '../yaml.js';
import { parseCommand, parseEnv, parsePrTarget, parseVerify } from './blocks.js';
import {
  BLOCK_ON,
  REQUIRED_ROLES,
  type AgentCommand,
  type AgentRef,
  type AgentsConfig,
  type BdcConfig,
  type ReviewerConfig,
} from './types.js';

const ROOT_KEYS = [
  'agents',
  'concurrency',
  'max_envs',
  'max_attempts',
  'reviewers',
  'keep_envs',
  'pr_targets',
  'env',
  'verify',
] as const;
const AGENT_KEYS = ['default', 'roles', 'custom'] as const;
const ROLE_NAME = /^[A-Za-z][A-Za-z0-9._:-]*$/;

export interface BdcParseResult {
  /** Present only when the document matches the schema. */
  config: BdcConfig | null;
  issues: Issue[];
  /**
   * Reviewer lens names when `reviewers` is a mapping.
   * Set even if a lens value is invalid, so prompt files can still be checked.
   */
  reviewerNames: string[] | null;
}

export function parseBdcYaml(text: string, file = 'bdc.yaml'): BdcParseResult {
  const yaml = parseYaml(text, file);
  if (yaml.issues.length > 0) return { config: null, issues: yaml.issues, reviewerNames: null };
  return parseBdcValue(yaml.value, file);
}

export function parseBdcValue(value: unknown, file = 'bdc.yaml'): BdcParseResult {
  const issues: Issue[] = [];
  const root = expectRecord(value, file, '', issues);
  if (!root) return { config: null, issues, reviewerNames: null };

  unknownFields(root, ROOT_KEYS, file, '', issues);
  const agents = parseAgents(root, file, issues);
  const concurrency = requireInt(root, 'concurrency', file, issues);
  const maxEnvs = requireInt(root, 'max_envs', file, issues);
  const maxAttempts = requireInt(root, 'max_attempts', file, issues);
  const reviewers = parseReviewers(root, file, issues);
  const keepEnvs = requireBool(root, 'keep_envs', file, issues);
  const prTargets = parsePrTargets(root, file, issues);
  const env = parseOptionalBlock(root, 'env', file, issues, parseEnv);
  const verify = parseOptionalBlock(root, 'verify', file, issues, parseVerify);

  const reviewerNames = reviewers.names;
  if (
    issues.length > 0 ||
    !agents ||
    concurrency === undefined ||
    maxEnvs === undefined ||
    maxAttempts === undefined ||
    !reviewers.config ||
    keepEnvs === undefined ||
    !prTargets ||
    env === 'invalid' ||
    verify === 'invalid'
  ) {
    return { config: null, issues, reviewerNames };
  }

  const config: BdcConfig = {
    agents,
    concurrency,
    max_envs: maxEnvs,
    max_attempts: maxAttempts,
    reviewers: reviewers.config,
    keep_envs: keepEnvs,
    pr_targets: prTargets,
  };
  if (env) config.env = env;
  if (verify) config.verify = verify;
  return { config, issues, reviewerNames };
}

function parseAgents(root: Record<string, unknown>, file: string, issues: Issue[]): AgentsConfig | undefined {
  if (!hasOwn(root, 'agents')) {
    push(issues, file, 'agents', 'required');
    return undefined;
  }
  const agents = expectRecord(root.agents, file, 'agents', issues);
  if (!agents) return undefined;
  const before = issues.length;
  unknownFields(agents, AGENT_KEYS, file, 'agents', issues);

  let agentDefault: string | undefined;
  if (!hasOwn(agents, 'default')) push(issues, file, 'agents.default', 'required');
  else agentDefault = expectString(agents.default, file, 'agents.default', issues);

  const roles = parseRoles(agents, file, issues);
  const custom = parseCustom(agents, file, issues);
  if (agentDefault === undefined || !roles || !custom || issues.length > before) return undefined;
  return { default: agentDefault, roles, custom };
}

function parseRoles(
  agents: Record<string, unknown>,
  file: string,
  issues: Issue[],
): Record<string, AgentRef> | undefined {
  if (!hasOwn(agents, 'roles')) {
    push(issues, file, 'agents.roles', 'required');
    return undefined;
  }
  const roles = expectRecord(agents.roles, file, 'agents.roles', issues);
  if (!roles) return undefined;
  const parsed: Record<string, AgentRef> = {};
  let ok = true;
  for (const name of Object.keys(roles)) {
    const path = `agents.roles.${name}`;
    if (!ROLE_NAME.test(name)) {
      push(issues, file, path, `invalid role name ${JSON.stringify(name)}`);
      ok = false;
      continue;
    }
    const value = roles[name];
    if (typeof value === 'string') {
      // TODO(p2-herdr-bridge): resolve this name against Herdr agent manifests.
      const agentName = expectString(value, file, path, issues);
      if (agentName === undefined) ok = false;
      else parsed[name] = agentName;
    } else {
      const command = parseCommand(value, file, path, issues);
      if (!command) ok = false;
      else parsed[name] = command;
    }
  }
  for (const required of REQUIRED_ROLES) {
    if (!hasOwn(roles, required)) {
      push(issues, file, `agents.roles.${required}`, 'required');
      ok = false;
    }
  }
  return ok ? parsed : undefined;
}

function parseCustom(
  agents: Record<string, unknown>,
  file: string,
  issues: Issue[],
): Record<string, AgentCommand> | undefined {
  if (!hasOwn(agents, 'custom')) return {};
  const custom = expectRecord(agents.custom, file, 'agents.custom', issues);
  if (!custom) return undefined;
  const parsed: Record<string, AgentCommand> = {};
  let ok = true;
  for (const name of Object.keys(custom)) {
    const path = `agents.custom.${name}`;
    const id = expectId(name, file, path, issues);
    const command = parseCommand(custom[name], file, path, issues);
    if (id === undefined || !command) ok = false;
    else parsed[id] = command;
  }
  return ok ? parsed : undefined;
}

function parseReviewers(
  root: Record<string, unknown>,
  file: string,
  issues: Issue[],
): { config: Record<string, ReviewerConfig> | null; names: string[] | null } {
  if (!hasOwn(root, 'reviewers')) {
    push(issues, file, 'reviewers', 'required');
    return { config: null, names: null };
  }
  const reviewers = expectRecord(root.reviewers, file, 'reviewers', issues);
  if (!reviewers) return { config: null, names: null };
  const names = Object.keys(reviewers);
  const config: Record<string, ReviewerConfig> = {};
  let ok = true;
  for (const name of names) {
    const path = `reviewers.${name}`;
    if (expectId(name, file, path, issues) === undefined) {
      ok = false;
      continue;
    }
    const entry = expectRecord(reviewers[name], file, path, issues);
    if (!entry) {
      ok = false;
      continue;
    }
    unknownFields(entry, ['block_on'], file, path, issues);
    if (!hasOwn(entry, 'block_on')) {
      push(issues, file, `${path}.block_on`, 'required');
      ok = false;
      continue;
    }
    const blockOn = expectEnum(entry.block_on, BLOCK_ON, file, `${path}.block_on`, issues);
    if (blockOn === undefined) ok = false;
    else config[name] = { block_on: blockOn };
  }
  return { config: ok ? config : null, names };
}

function parsePrTargets(root: Record<string, unknown>, file: string, issues: Issue[]): BdcConfig['pr_targets'] | undefined {
  if (!hasOwn(root, 'pr_targets')) {
    push(issues, file, 'pr_targets', 'required');
    return undefined;
  }
  if (!Array.isArray(root.pr_targets)) {
    push(issues, file, 'pr_targets', `expected a list, got ${got(root.pr_targets)}`);
    return undefined;
  }
  const targets: BdcConfig['pr_targets'] = [];
  let ok = true;
  for (let i = 0; i < root.pr_targets.length; i++) {
    const target = parsePrTarget(root.pr_targets[i], file, `pr_targets[${i}]`, issues);
    if (!target) ok = false;
    else targets.push(target);
  }
  return ok ? targets : undefined;
}

function requireInt(
  root: Record<string, unknown>,
  key: 'concurrency' | 'max_envs' | 'max_attempts',
  file: string,
  issues: Issue[],
): number | undefined {
  if (!hasOwn(root, key)) {
    push(issues, file, key, 'required');
    return undefined;
  }
  return expectInt(root[key], file, key, issues, 1);
}

function requireBool(root: Record<string, unknown>, key: 'keep_envs', file: string, issues: Issue[]): boolean | undefined {
  if (!hasOwn(root, key)) {
    push(issues, file, key, 'required');
    return undefined;
  }
  if (typeof root[key] !== 'boolean') {
    push(issues, file, key, `expected a boolean, got ${got(root[key])}`);
    return undefined;
  }
  return root[key] as boolean;
}

function parseOptionalBlock<T>(
  root: Record<string, unknown>,
  key: 'env' | 'verify',
  file: string,
  issues: Issue[],
  parse: (value: unknown, file: string, path: string, issues: Issue[]) => T | undefined,
): T | undefined | 'invalid' {
  if (!hasOwn(root, key)) return undefined;
  const before = issues.length;
  const parsed = parse(root[key], file, key, issues);
  if (parsed === undefined || issues.length > before) return 'invalid';
  return parsed;
}
