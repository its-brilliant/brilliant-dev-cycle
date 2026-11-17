/**
 * The effects a real run is wired with (slice 2): agents run in hidden hc terminals with bdc's
 * MCP server attached; git, verification, proof and the pull request are still scripted until
 * slice 4.
 */
import { fileURLToPath } from 'node:url';
import { commandFor, writeMcpConfig } from '../agents/command.js';
import { AGENT_ENV, agentDir } from '../contracts/inbox.js';
import type { RunInput } from '../machines/run.js';
import type { WiredEffects } from '../runtime/wire.js';
import { hcEffects } from './hc.js';
import { scriptedActors } from './scripted.js';

/** How the MCP server runs bdc itself: this Node, this package's CLI. */
export function bdcCommand(): string[] {
  return [process.execPath, fileURLToPath(new URL('../cli/bin.js', import.meta.url))];
}

export function realEffects(input: RunInput, options: { hcBin?: string } = {}): WiredEffects {
  const bdcBin = bdcCommand();
  const agents = hcEffects({
    root: input.root,
    runId: input.runId,
    ...(options.hcBin === undefined ? {} : { hcBin: options.hcBin }),
    commandFor: (job) => {
      const env = {
        [AGENT_ENV.root]: input.root,
        [AGENT_ENV.run]: input.runId,
        [AGENT_ENV.key]: job.key,
        [AGENT_ENV.role]: job.role,
        [AGENT_ENV.submit]: job.submit,
      };
      const mcpConfigPath = writeMcpConfig(agentDir(input.root, input.runId, job.key), bdcBin, env);
      return commandFor(job, { mcpConfigPath, bdcBin });
    },
  });
  return { ...scriptedActors({ goal: input.goal }), ...agents };
}
