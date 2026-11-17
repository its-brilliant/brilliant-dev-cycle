import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MCP_CONFIG_FILE, commandFor, writeMcpConfig } from '../../src/agents/command.js';
import { GET_CONTEXT_TOOL, MCP_SERVER_NAME } from '../../src/agents/mcp-server.js';
import { ROLE_SYSTEM } from '../../src/agents/prompts.js';
import type { AgentJob } from '../../src/contracts/actors.js';

let dir: string;
const BDC_BIN = ['/repo/node_modules/.bin/../..', '/repo/dist/cli/bin.js'];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-command-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function job(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    key: 'run-1/p1/t1/builder',
    role: 'builder',
    agent: { cli: 'claude', model: '' },
    cwd: dir,
    prompt: 'Implement task t1.',
    submit: 'task',
    timeoutMs: 1_800_000,
    keepAlive: true,
    labels: { 'bdc.run': 'run-1' },
    ...overrides,
  };
}

describe('writeMcpConfig', () => {
  it('writes one stdio server that runs bdc mcp, with the job environment', () => {
    const file = writeMcpConfig(dir, BDC_BIN, { BDC_KEY: 'run-1/p1/t1/builder' });
    expect(file).toBe(path.join(dir, MCP_CONFIG_FILE));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      mcpServers: {
        [MCP_SERVER_NAME]: {
          command: '/repo/node_modules/.bin/../..',
          args: ['/repo/dist/cli/bin.js', 'mcp'],
          env: { BDC_KEY: 'run-1/p1/t1/builder' },
        },
      },
    });
  });

  it('needs a command to run bdc with', () => {
    expect(() => writeMcpConfig(dir, [])).toThrow(/bdcBin is empty/);
  });
});

describe('commandFor', () => {
  const mcpConfigPath = '/repo/.herd/runs/run-1/agents/run-1_p1_t1_builder/mcp.json';

  it('starts claude interactively with the prompt positional, the role prompt appended and the two tools allowed', () => {
    const { argv, env } = commandFor(job(), { mcpConfigPath, bdcBin: BDC_BIN });
    expect(argv).toEqual([
      'claude',
      '--mcp-config',
      mcpConfigPath,
      '--allowedTools',
      'mcp__bdc__report_task',
      `mcp__bdc__${GET_CONTEXT_TOOL}`,
      '--append-system-prompt',
      ROLE_SYSTEM.builder,
      'Implement task t1.',
    ]);
    // Interactive: `-p` exits instead of keeping the session for the PM's follow-ups (§3.3).
    expect(argv).not.toContain('-p');
    expect(argv).not.toContain('--print');
    expect(env).toEqual({});
  });

  it('passes the model when the role chose one', () => {
    const { argv } = commandFor(job({ agent: { cli: 'claude', model: 'claude-opus-5-5' } }), { mcpConfigPath, bdcBin: BDC_BIN });
    expect(argv.slice(0, 3)).toEqual(['claude', '--model', 'claude-opus-5-5']);
  });

  it('starts pi interactively, without a tools list it does not take', () => {
    const { argv } = commandFor(job({ agent: { cli: 'pi', model: '' } }), { mcpConfigPath, bdcBin: BDC_BIN });
    expect(argv).toEqual([
      'pi',
      '--mcp-config',
      mcpConfigPath,
      '--append-system-prompt',
      ROLE_SYSTEM.builder,
      'Implement task t1.',
    ]);
    const withModel = commandFor(job({ agent: { cli: 'pi', model: 'anthropic/claude-opus-5-5' } }), {
      mcpConfigPath,
      bdcBin: BDC_BIN,
    });
    expect(withModel.argv.slice(0, 3)).toEqual(['pi', '--model', 'anthropic/claude-opus-5-5']);
  });

  it('names the job\'s own submit tool, per role', () => {
    const reviewer = commandFor(job({ role: 'reviewer', submit: 'findings' }), { mcpConfigPath, bdcBin: BDC_BIN });
    expect(reviewer.argv).toContain('mcp__bdc__submit_findings');
    const verifier = commandFor(job({ role: 'verifier', submit: 'proof' }), { mcpConfigPath, bdcBin: BDC_BIN });
    expect(verifier.argv).toContain('mcp__bdc__submit_proof');
  });

  it('has no adapter for a CLI it does not know yet', () => {
    expect(() => commandFor(job({ agent: { cli: 'codex', model: '' } }), { mcpConfigPath, bdcBin: BDC_BIN })).toThrow(
      'bdc has no adapter for codex yet (v2.0: claude, pi)',
    );
  });
});
