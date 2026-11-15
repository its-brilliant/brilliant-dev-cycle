import {
  expectBool,
  expectProjectPath,
  expectRecord,
  expectString,
  hasOwn,
  unknownFields,
} from '../fields.js';
import { got, joinPath, push, type Issue } from '../issues.js';
import type { AgentCommand, EnvConfig, PrTarget, VerifyCheck, VerifyConfig } from './types.js';

const COMMAND_KEYS = ['command', 'herdr_manifest'] as const;
const ENV_KEYS = ['up', 'down'] as const;
const VERIFY_KEYS = ['setup', 'setup_md', 'checks', 'evidence'] as const;
const CHECK_KEYS = ['run', 'agent'] as const;
const GITHUB_KEYS = ['provider', 'repo', 'base', 'draft'] as const;
const GITLAB_KEYS = ['provider', 'project', 'base', 'draft'] as const;

export function parseCommand(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): AgentCommand | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, COMMAND_KEYS, file, path, issues);
  const commandPath = joinPath(path, 'command');
  if (!hasOwn(obj, 'command')) {
    push(issues, file, commandPath, 'required');
  }
  const command = hasOwn(obj, 'command') ? expectString(obj.command, file, commandPath, issues) : undefined;
  let herdrManifest: string | null = null;
  if (hasOwn(obj, 'herdr_manifest')) {
    const manifest = obj.herdr_manifest;
    if (manifest === null) {
      herdrManifest = null;
    } else {
      const parsed = expectString(manifest, file, joinPath(path, 'herdr_manifest'), issues);
      if (parsed === undefined) return undefined;
      herdrManifest = parsed;
    }
  }
  if (command === undefined || issues.length > before) return undefined;
  return { command, herdr_manifest: herdrManifest };
}

function requireString(
  obj: Record<string, unknown>,
  key: string,
  file: string,
  base: string,
  issues: Issue[],
): string | undefined {
  const path = joinPath(base, key);
  if (!hasOwn(obj, key)) {
    push(issues, file, path, 'required');
    return undefined;
  }
  return expectString(obj[key], file, path, issues);
}

export function parseEnv(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): EnvConfig | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, ENV_KEYS, file, path, issues);
  const up = requireString(obj, 'up', file, path, issues);
  const down = requireString(obj, 'down', file, path, issues);
  if (up === undefined || down === undefined || issues.length > before) return undefined;
  return { up, down };
}

export function parseVerify(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): VerifyConfig | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  unknownFields(obj, VERIFY_KEYS, file, path, issues);

  let setup: string | undefined;
  let setupMd: string | undefined;
  if (hasOwn(obj, 'setup')) {
    setup = expectString(obj.setup, file, joinPath(path, 'setup'), issues);
  }
  if (hasOwn(obj, 'setup_md')) {
    setupMd = expectString(obj.setup_md, file, joinPath(path, 'setup_md'), issues);
  }
  if (hasOwn(obj, 'setup') && hasOwn(obj, 'setup_md')) {
    push(issues, file, path, 'set setup or setup_md, not both');
  }

  const checks = parseChecks(obj, file, path, issues);
  const evidence = parseEvidence(obj, file, path, issues);
  if (checks === undefined || evidence === undefined || issues.length > before) return undefined;

  const verify: VerifyConfig = { checks, evidence };
  if (setup !== undefined) verify.setup = setup;
  if (setupMd !== undefined) verify.setup_md = setupMd;
  return verify;
}

function parseChecks(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): VerifyCheck[] | undefined {
  const checksPath = joinPath(path, 'checks');
  if (!hasOwn(obj, 'checks')) {
    push(issues, file, checksPath, 'required');
    return undefined;
  }
  if (!Array.isArray(obj.checks)) {
    push(issues, file, checksPath, `expected a list, got ${got(obj.checks)}`);
    return undefined;
  }
  if (obj.checks.length === 0) {
    push(issues, file, checksPath, 'expected at least one check');
    return undefined;
  }
  const checks: VerifyCheck[] = [];
  let ok = true;
  for (let i = 0; i < obj.checks.length; i++) {
    const check = parseCheck(obj.checks[i], file, `${checksPath}[${i}]`, issues);
    if (!check) ok = false;
    else checks.push(check);
  }
  return ok ? checks : undefined;
}

function parseCheck(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): VerifyCheck | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const hasRun = hasOwn(obj, 'run');
  const hasAgent = hasOwn(obj, 'agent');
  unknownFields(obj, CHECK_KEYS, file, path, issues);
  if (hasRun === hasAgent) {
    push(issues, file, path, 'set exactly one of run or agent');
    return undefined;
  }
  if (hasRun) {
    const run = expectString(obj.run, file, joinPath(path, 'run'), issues);
    return run === undefined ? undefined : { kind: 'run', run };
  }
  const agent = expectString(obj.agent, file, joinPath(path, 'agent'), issues);
  return agent === undefined ? undefined : { kind: 'agent', agent };
}

function parseEvidence(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): string[] | undefined {
  if (!hasOwn(obj, 'evidence')) return [];
  const evidencePath = joinPath(path, 'evidence');
  if (!Array.isArray(obj.evidence)) {
    push(issues, file, evidencePath, `expected a list, got ${got(obj.evidence)}`);
    return undefined;
  }
  const evidence: string[] = [];
  let ok = true;
  for (let i = 0; i < obj.evidence.length; i++) {
    const item = expectString(obj.evidence[i], file, `${evidencePath}[${i}]`, issues);
    if (item === undefined) ok = false;
    else evidence.push(item);
  }
  return ok ? evidence : undefined;
}

export function parsePrTarget(
  value: unknown,
  file: string,
  path: string,
  issues: Issue[],
): PrTarget | undefined {
  const obj = expectRecord(value, file, path, issues);
  if (!obj) return undefined;
  const before = issues.length;
  if (!hasOwn(obj, 'provider')) {
    push(issues, file, joinPath(path, 'provider'), 'required');
    return undefined;
  }
  const provider = obj.provider;
  if (provider !== 'github' && provider !== 'gitlab') {
    push(
      issues,
      file,
      joinPath(path, 'provider'),
      `expected "github" or "gitlab", got ${got(provider)}`,
    );
    return undefined;
  }
  unknownFields(obj, provider === 'github' ? GITHUB_KEYS : GITLAB_KEYS, file, path, issues);
  const base = requireString(obj, 'base', file, path, issues);
  const draft = parseDraft(obj, file, path, issues);
  if (provider === 'github') {
    const repo = requireProjectPath(obj, 'repo', 'github', file, path, issues);
    if (repo === undefined || base === undefined || draft === undefined || issues.length > before) {
      return undefined;
    }
    return { provider: 'github', repo, base, draft };
  }
  const project = requireProjectPath(obj, 'project', 'gitlab', file, path, issues);
  if (project === undefined || base === undefined || draft === undefined || issues.length > before) {
    return undefined;
  }
  return { provider: 'gitlab', project, base, draft };
}

function requireProjectPath(
  obj: Record<string, unknown>,
  key: string,
  provider: 'github' | 'gitlab',
  file: string,
  base: string,
  issues: Issue[],
): string | undefined {
  const path = joinPath(base, key);
  if (!hasOwn(obj, key)) {
    push(issues, file, path, `required for provider "${provider}"`);
    return undefined;
  }
  return expectProjectPath(obj[key], file, path, issues);
}

function parseDraft(
  obj: Record<string, unknown>,
  file: string,
  path: string,
  issues: Issue[],
): boolean | undefined {
  if (!hasOwn(obj, 'draft')) return false;
  return expectBool(obj.draft, file, joinPath(path, 'draft'), issues);
}

