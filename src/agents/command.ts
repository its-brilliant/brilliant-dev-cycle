/**
 * How bdc starts an agent CLI (spec §3.2, §3.4): the command line, the MCP config file that attaches
 * bdc's tools, and the environment it adds on top of the launcher's.
 *
 * Both supported CLIs run *interactively* with the prompt as a positional argument — `claude -p` and
 * `pi --print` are one-shot modes that exit instead of keeping the session for follow-ups, so bdc
 * never passes them. `--append-system-prompt` carries the role's standing instructions, so the
 * positional prompt can stay about this one job.
 *
 * Nothing here launches anything: the hc effects call `writeMcpConfig` once per job and `commandFor`
 * per launch, and start the terminal themselves.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { AgentJob } from '../contracts/actors.js';
import { MCP_SERVER_NAME, jobToolNames } from './mcp-server.js';
import { ROLE_SYSTEM } from './prompts.js';

export interface CommandOptions {
  /** The `mcp.json` `writeMcpConfig` wrote for this job. */
  mcpConfigPath: string;
  /** How to run bdc itself: `[command, ...args]`, e.g. `['node', '/repo/dist/cli/bin.js']`. */
  bdcBin: string[];
}

export interface AgentCommand {
  /** argv as the CLI takes it: the program first, the prompt last. */
  argv: string[];
  /** Extra environment. Empty: the launcher adds AGENT_ENV to the terminal itself. */
  env: Record<string, string>;
}

export function commandFor(job: AgentJob, options: CommandOptions): AgentCommand {
  const adapter = ADAPTERS[job.agent.cli];
  if (adapter === undefined) throw new Error(`bdc has no adapter for ${job.agent.cli} yet (v2.0: claude, pi)`);
  return { argv: adapter(job, options), env: {} };
}

/** One adapter per CLI bdc supports; `job.agent.model` empty means the CLI's own default. */
const ADAPTERS: Record<string, (job: AgentJob, options: CommandOptions) => string[]> = {
  claude: (job, options) => [
    'claude',
    ...modelArgs(job),
    '--mcp-config',
    options.mcpConfigPath,
    // claude asks before it uses a tool that is not allowed, and an unanswered prompt looks like a stuck
    // agent (§3.3): allow every bdc tool this job has (a PM has ask_user, submit_brief, reply, decide).
    '--allowedTools',
    ...jobToolNames(job.submit).map(mcpToolName),
    '--append-system-prompt',
    ROLE_SYSTEM[job.role],
    job.prompt,
  ],
  pi: (job, options) => [
    'pi',
    ...modelArgs(job),
    '--mcp-config',
    options.mcpConfigPath,
    '--append-system-prompt',
    ROLE_SYSTEM[job.role],
    job.prompt,
  ],
};

function modelArgs(job: AgentJob): string[] {
  return job.agent.model === '' ? [] : ['--model', job.agent.model];
}

/** MCP tools are named `mcp__<server>__<tool>` in the CLIs. */
function mcpToolName(tool: string): string {
  return `mcp__${MCP_SERVER_NAME}__${tool}`;
}

/** The MCP config file of a job, inside the job's own directory. */
export const MCP_CONFIG_FILE = 'mcp.json';

/**
 * Write the job's `mcp.json`: one stdio server, `bdc mcp`, started with the same bdc build as the
 * daemon. `env` is the job's AGENT_ENV: the server needs it to know whose submission it takes, and
 * a CLI that does not pass its own environment to stdio servers would otherwise leave it unset.
 * Returns the file's path, which `commandFor` takes as `mcpConfigPath`.
 */
export function writeMcpConfig(dir: string, bdcBin: string[], env: Record<string, string> = {}): string {
  const command = bdcBin[0];
  if (command === undefined) {
    throw new Error('bdcBin is empty: bdc needs the command that runs itself, e.g. ["node", "/repo/dist/cli/bin.js"]');
  }
  const config = {
    mcpServers: {
      [MCP_SERVER_NAME]: { command, args: [...bdcBin.slice(1), 'mcp'], env: { ...env } },
    },
  };
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, MCP_CONFIG_FILE);
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}
