/**
 * The effects a real run is wired with: agents run in hidden hc terminals with bdc's MCP server
 * attached (§3.2, §3.4); git, verification, proof and the pull request are real (§7.3, §7.4,
 * §4.4.1, §4.6).
 */
import { fileURLToPath } from 'node:url';
import { commandFor, writeMcpConfig } from '../agents/command.js';
import { AGENT_ENV, agentDir } from '../contracts/inbox.js';
import type { RunInput } from '../machines/run.js';
import type { WiredEffects } from '../runtime/wire.js';
import { hcEffects } from './hc.js';
import { gitEffects } from './git.js';
import { prEffect } from './pr.js';
import { proofEffect } from './proof.js';
import { verifyEffect } from './verify.js';

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
  return {
    ...agents,
    ...gitEffects(),
    runVerification: verifyEffect(),
    checkProof: proofEffect({ base: input.root }),
    ...prEffect(),
  };
}
