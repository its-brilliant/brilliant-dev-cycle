import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCEPTED, GET_CONTEXT_TOOL, createBdcServer } from '../../src/agents/mcp-server.js';
import { SUBMIT_TOOLS, type SubmitKind } from '../../src/contracts/actors.js';
import { SUBMISSIONS, agentDir, inboxFile, type InboxEntry } from '../../src/contracts/inbox.js';
import type { SubmitEnv } from '../../src/agents/submit.js';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'bdc-mcp-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A client and the job's server, connected in-process over the SDK's linked transport pair. */
async function connect(kind: SubmitKind): Promise<{ client: Client; env: SubmitEnv; close: () => Promise<void> }> {
  const env: SubmitEnv = { root, run: 'run-1', key: 'run-1/spec/1', kind };
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createBdcServer(env);
  await server.connect(serverTransport);
  const client = new Client({ name: 'bdc-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    env,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function inbox(env: SubmitEnv): InboxEntry[] {
  const file = inboxFile(agentDir(env.root, env.run, env.key));
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as InboxEntry);
}

describe('bdc mcp', () => {
  it('lists exactly the job submit tool and get_context, with the schema of the job kind', async () => {
    const { client, close } = await connect('plan');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual([SUBMIT_TOOLS.plan, GET_CONTEXT_TOOL]);

      const [submitTool, contextTool] = tools;
      expect(submitTool?.inputSchema.type).toBe('object');
      const phase = (submitTool?.inputSchema.properties as Record<string, { items?: unknown }>).phases;
      expect(phase).toBeDefined();
      expect(submitTool?.description).toMatch(/ends your job/i);
      expect(contextTool?.inputSchema).toEqual({ type: 'object', properties: {} });
    } finally {
      await close();
    }
  });

  it('advertises a decision as an object with oneOf, since a union is still an object on the wire', async () => {
    const { client, close } = await connect('decision');
    try {
      const { tools } = await client.listTools();
      const decide = tools.find((tool) => tool.name === SUBMIT_TOOLS.decision);
      expect(decide?.inputSchema).toMatchObject({ type: 'object' });
      expect(decide?.inputSchema.oneOf).toBeDefined();
    } finally {
      await close();
    }
  });

  it('a PM session gets its brief, reply and decide tools, and each call is filed under its own kind', async () => {
    const { client, env, close } = await connect('brief');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name).sort()).toEqual([SUBMIT_TOOLS.brief, SUBMIT_TOOLS.decision, SUBMIT_TOOLS.reply, GET_CONTEXT_TOOL].sort());
      const result = await client.callTool({ name: SUBMIT_TOOLS.reply, arguments: { text: 'On it.' } });
      expect(result.isError).toBeFalsy();
      const lines = fs.readFileSync(inboxFile(agentDir(env.root, env.run, env.key)), 'utf8').trim().split('\n');
      expect(JSON.parse(lines.at(-1) ?? '{}')).toMatchObject({ kind: 'reply', submission: { text: 'On it.' } });
    } finally {
      await close();
    }
  });

  it('takes a valid submission, writes the inbox entry and says the turn is over', async () => {
    const { client, env, close } = await connect('spec');
    try {
      const result = await client.callTool({ name: SUBMIT_TOOLS.spec, arguments: { markdown: '# Spec' } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: ACCEPTED }]);
      expect(inbox(env)).toMatchObject([{ seq: 1, kind: 'spec', submission: { markdown: '# Spec', notes: [] } }]);
    } finally {
      await close();
    }
  });

  it('answers a rejected submission with an error result carrying the problems, and writes nothing', async () => {
    const { client, env, close } = await connect('spec');
    try {
      const result = await client.callTool({ name: SUBMIT_TOOLS.spec, arguments: { markdown: '' } });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? '';
      expect(text).toMatch(/^- markdown: /m);
      expect(text).toContain(`call ${SUBMIT_TOOLS.spec} again`);
      expect(inbox(env)).toEqual([]);
    } finally {
      await close();
    }
  });

  it('does not take another job kind\'s tool', async () => {
    const { client, close } = await connect('task');
    try {
      const result = await client.callTool({ name: SUBMIT_TOOLS.spec, arguments: { markdown: '# Spec' } });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text: string }>)[0]?.text).toContain(SUBMIT_TOOLS.task);
    } finally {
      await close();
    }
  });

  it('returns the job context file from get_context, and a note when there is none', async () => {
    const { client, env, close } = await connect('task');
    try {
      const none = await client.callTool({ name: GET_CONTEXT_TOOL, arguments: {} });
      expect((none.content as Array<{ text: string }>)[0]?.text).toMatch(/no context file/);

      const dir = agentDir(env.root, env.run, env.key);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'context.md'), '# Phase p1\n');
      const found = await client.callTool({ name: GET_CONTEXT_TOOL, arguments: {} });
      expect((found.content as Array<{ text: string }>)[0]?.text).toBe('# Phase p1\n');
    } finally {
      await close();
    }
  });

  it('validates with the contract schema of the job kind', async () => {
    // The advertised schema and the tool's validation are the same object, so a payload the contract
    // accepts never comes back as a rejection.
    for (const kind of Object.keys(SUBMISSIONS) as SubmitKind[]) {
      const sample = SAMPLE[kind];
      const { client, close } = await connect(kind);
      try {
        const result = await client.callTool({ name: SUBMIT_TOOLS[kind], arguments: sample });
        expect(result.isError, `${kind} rejected ${JSON.stringify(sample)}`).toBeFalsy();
      } finally {
        await close();
      }
    }
  });
});

/** One minimal accepted payload per kind, so the loop above proves every schema is wired. */
const SAMPLE: Record<SubmitKind, Record<string, unknown>> = {
  brief: { brief: 'Ship the thing' },
  reply: { text: 'On it.' },
  decision: { action: 'continue', reason: 'the flake is known' },
  spec: { markdown: '# Spec' },
  plan: {
    phases: [{ id: 'p1', title: 'One', tasks: [{ id: 't1', title: 'Do it' }], proof: [{ kind: 'tests' }] }],
  },
  task: { summary: 'did it' },
  findings: { findings: [] },
  proof: { items: [{ kind: 'screenshot', shows: 'the new screen' }] },
};
