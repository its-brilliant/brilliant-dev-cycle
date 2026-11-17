/**
 * `bdc init <dir>` (spec §3.1, §7.4, §10): write a project's `bdc.yaml`, the one file that says
 * which CLI and model every role uses, which lenses review, and how this repo is verified.
 *
 * First run in the Herdr UI fills a form and hands the answer here as JSON (`screens/setup.js`),
 * so the same validation the daemon applies when it reads `bdc.yaml` applies before the file is
 * written: a config that fails `ProjectConfig` is refused with its problems, never written.
 *
 * `--print-defaults` answers the starting config: every role on the CLI this machine has (claude
 * for the thinking roles, pi for the builder, whichever of the two exists otherwise), the security
 * lens, and no verification yet. It is a valid config, so `bdc init . --config "$(bdc init .
 * --print-defaults)"` is the same as accepting every default.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { ProjectConfig, ROLES, type AgentChoice, type Role } from '../contracts/domain.js';

/** `process.env`, or any slice of it: tests pass their own so the real PATH is never read. */
export type Env = Record<string, string | undefined>;

/** The CLIs bdc has an adapter for (§3.1: claude and pi in v2.0). */
export const SUPPORTED_CLIS = ['claude', 'pi'] as const;

/** The first line of every `bdc.yaml` this command writes: what the file is, and who wrote it. */
export const CONFIG_HEADER = [
  '# bdc.yaml: how this project runs (docs/spec.md §10).',
  '# Written by `bdc init`; edit it here, or in first run and Settings.',
].join('\n');

/** A config file's name in the project folder. */
export const CONFIG_FILE = 'bdc.yaml';

/** The CLIs of `SUPPORTED_CLIS` that are on PATH, in that order. */
export function installedClis(env: Env = process.env): string[] {
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter((dir) => dir !== '');
  return SUPPORTED_CLIS.filter((cli) => dirs.some((dir) => isExecutable(path.join(dir, cli))));
}

function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Every role on a CLI this machine has: claude for the PM, the spec writer, the planner, the
 * reviewer and the verifier, pi for the builder, and whichever of the two exists for both when
 * only one does. A model is left empty, which means the CLI's own default.
 */
export function defaultAgents(installed: string[]): Record<Role, AgentChoice> {
  const has = (cli: string): boolean => installed.includes(cli);
  const any = SUPPORTED_CLIS.find(has) ?? SUPPORTED_CLIS[0];
  const thinking = has('claude') ? 'claude' : any;
  const building = has('pi') ? 'pi' : any;
  const agents = {} as Record<Role, AgentChoice>;
  for (const role of ROLES) agents[role] = { cli: role === 'builder' ? building : thinking, model: '' };
  return agents;
}

/** The starting config `--print-defaults` prints, with every default filled in. */
export function defaultConfig(installed: string[] = installedClis()): ProjectConfig {
  return ProjectConfig.parse({ agents: defaultAgents(installed), lenses: { security: { block_on: 'high' } }, verification: null });
}

/** A config as YAML, under the header comment. */
export function configToYaml(config: ProjectConfig): string {
  return `${CONFIG_HEADER}\n${stringifyYaml(config, { lineWidth: 0 })}`;
}

/** The parsed config, or the problems that stop it being one. */
export type ConfigResult = { ok: true; config: ProjectConfig } | { ok: false; problems: string[] };

/** Validate the JSON a caller passed to `--config` with the same schema `bdc.yaml` is read with. */
export function parseConfigJson(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { ok: false, problems: [`the config is not JSON: ${message(error)}`] };
  }
  return validateConfig(raw);
}

/** Validate an already-parsed config value. */
export function validateConfig(raw: unknown): ConfigResult {
  const parsed = ProjectConfig.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`) };
  }
  return { ok: true, config: parsed.data };
}

/** What writing the config did: the file, or why it did not write one. */
export type WriteResult = { ok: true; file: string } | { ok: false; error: string };

/**
 * Write `<dir>/bdc.yaml`. An existing file is the person's own config, so it is only replaced
 * when `force` says so; a folder that does not exist is a mistake, not something to create.
 */
export function writeProjectConfig(dir: string, config: ProjectConfig, options: { force?: boolean } = {}): WriteResult {
  const root = path.resolve(dir);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return { ok: false, error: `there is no folder ${root}` };
  }
  if (!stat.isDirectory()) return { ok: false, error: `${root} is not a folder` };
  const file = path.join(root, CONFIG_FILE);
  if (fs.existsSync(file) && options.force !== true) {
    return { ok: false, error: `${file} already exists; pass --force to replace it` };
  }
  fs.writeFileSync(file, configToYaml(config));
  return { ok: true, file };
}

/** The config the YAML in `text` describes, or the problems: what the round trip is checked with. */
export function readConfigYaml(text: string): ConfigResult {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return { ok: false, problems: [`the YAML is not valid: ${message(error)}`] };
  }
  return validateConfig(raw);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
