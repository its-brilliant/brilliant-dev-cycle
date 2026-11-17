/**
 * `bdc mcp`: the MCP server an agent talks to (spec §3.4). It is scoped to one job by the AGENT_ENV
 * bdc starts the agent with, and it exposes exactly two tools:
 *
 * - the job's submit tool (name from SUBMIT_TOOLS, input schema from SUBMISSIONS for the job's kind),
 *   which validates the result through `submit` and ends the agent's turn;
 * - `get_context`, which hands the agent the context file bdc wrote for the job.
 *
 * Why the low-level `Server` and not `McpServer`: `McpServer.registerTool` validates the arguments
 * with the tool's schema *before* the handler and answers with the SDK's own message, so a rejected
 * submission would never reach bdc and could not carry bdc's problems — the same `path: message`
 * lines `bdc submit` prints, which is what the agent needs to fix its payload. Owning the two
 * request handlers lets bdc advertise the schema from SUBMISSIONS and still answer a rejection in
 * bdc's words.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { SUBMIT_TOOLS, type SubmitKind } from '../contracts/actors.js';
import { SUBMISSIONS, agentDir } from '../contracts/inbox.js';
import { submit, type SubmitEnv } from './submit.js';

export const MCP_SERVER_NAME = 'bdc';

export const GET_CONTEXT_TOOL = 'get_context';

/** What the agent must pass to the submit tool of each kind, and that this call ends its turn. */
const SUBMIT_DESCRIPTIONS: Record<SubmitKind, string> = {
  brief:
    'Submit the intake brief: { brief, decisions: [{ question, answer }], assumptions: [] }. Call it once the person ' +
    'confirmed the shared understanding. This ends your job.',
  reply: 'Reply to the person in PM chat: { text }. This ends this turn; they may write again.',
  decision:
    'Decide on the blocked phase: { action: "fix" | "continue" | "stop", reason, instructions?, builder? }. This ends ' +
    'this turn.',
  spec:
    'Submit the spec: { markdown, notes }. On a revision, `notes` says per comment what you changed. This ends your ' +
    'job.',
  plan:
    'Submit the plan: { phases: [{ id, title, deps, tasks: [{ id, title, paths }], checks, proof }] }. bdc validates ' +
    'it (schema, cycles, unique ids, disjoint task paths, proof per phase) and answers with what to fix. This ends ' +
    'your job.',
  task:
    'Report your task: { summary, notes } once your work is committed on your branch; `notes` lists anything you ' +
    'could not do. This ends this turn; bdc may send a fix later.',
  findings:
    'Submit your findings for this lens: { findings: [{ id, severity: "low" | "medium" | "high" | "critical", ' +
    'summary, file?, line?, fix? }] }. An empty list is a clean review. This ends your job.',
  proof:
    'Submit the proof items you produced: { items: [{ kind, shows, file }] }, where `file` is a path under this ' +
    'worktree and `shows` says what the item demonstrates. This ends your job.',
};

const GET_CONTEXT_DESCRIPTION =
  'The goal, spec, phase and task bdc wrote for this job, as markdown. Call it when the prompt in your terminal is ' +
  'not enough; it never ends your job.';

/** The message an accepted submission answers with: the agent's turn is over, and it stays for follow-ups. */
export const ACCEPTED = 'Submitted. You are done with this turn; wait for further instructions.';

/**
 * The MCP server for one job. Call `connect` with a transport: `serveMcp` does it over stdio, and the
 * tests use the SDK's in-memory pair.
 */
export function createBdcServer(env: SubmitEnv): Server {
  const server = new Server({ name: MCP_SERVER_NAME, version: '2.0.0' }, { capabilities: { tools: {} } });
  const submitToolName = SUBMIT_TOOLS[env.kind];

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [submitTool(env.kind, submitToolName), contextTool()],
  }));

  server.setRequestHandler(CallToolRequestSchema, (request) => {
    const name = request.params.name;
    if (name === GET_CONTEXT_TOOL) return Promise.resolve(text(contextText(env)));
    if (name !== submitToolName) {
      return Promise.resolve(
        rejected(`bdc has no tool named ${name} for this job. Your tool is ${submitToolName}; use it to report.`),
      );
    }
    const result = submit(env, request.params.arguments ?? {});
    if (!result.ok) {
      const problems = result.problems.map((problem) => `- ${problem}`).join('\n');
      return Promise.resolve(rejected(`bdc rejected the submission:\n${problems}\nFix it and call ${submitToolName} again.`));
    }
    return Promise.resolve(text(ACCEPTED));
  });

  // ── ask_user (slice 3, spec §3.4) ───────────────────────────────────────────────────
  // The PM's question tool: `ask_user({ questions })` blocks until the person answers in the UI and
  // returns their answers. It needs the run's UI to carry a question out and an answer back, which
  // is slice 3. Until then the PM does not get this tool, and its system prompt says it may not ask.

  return server;
}

/** Run the job's MCP server over stdio, until the agent CLI closes the pipe. */
export async function serveMcp(env: SubmitEnv, transport = new StdioServerTransport()): Promise<Server> {
  const server = createBdcServer(env);
  await server.connect(transport);
  return server;
}

function submitTool(kind: SubmitKind, name: string): Tool {
  return { name, description: SUBMIT_DESCRIPTIONS[kind], inputSchema: inputSchemaOf(SUBMISSIONS[kind]) };
}

function contextTool(): Tool {
  return { name: GET_CONTEXT_TOOL, description: GET_CONTEXT_DESCRIPTION, inputSchema: { type: 'object', properties: {} } };
}

/**
 * The submission schema as the JSON Schema MCP advertises. A submission is always an object on the
 * wire, so a union (a decision) is advertised as an object with `oneOf` rather than a bare `oneOf`.
 */
function inputSchemaOf(schema: z.ZodType): Tool['inputSchema'] {
  const json = { ...(z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>) };
  delete json['$schema'];
  return { type: 'object', ...json } as Tool['inputSchema'];
}

/** `<agentDir>/context.md`, written by the job's launcher, or a line saying there is none. */
function contextText(env: SubmitEnv): string {
  const file = path.join(agentDir(env.root, env.run, env.key), 'context.md');
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return 'bdc has no context file for this job: what your prompt says is all of it.';
  }
}

function text(body: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: body }] };
}

function rejected(body: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { ...text(body), isError: true };
}
