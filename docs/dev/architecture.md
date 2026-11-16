# bdc v2 architecture (for contributors and agents)

Read [docs/spec.md](../spec.md) first; this file only says where things live and the rules for code.

## Modules

| Path | What | Depends on |
|---|---|---|
| `src/contracts/` | zod schemas and types shared by everything: domain data, events, actor I/O. Change these only on purpose. | zod |
| `src/machines/agent.ts` | `agentMachine` (spec §5.5) and its completion rules (§3.3) | contracts, xstate |
| `src/machines/phase.ts` | `phaseMachine` (§5.3) | contracts, xstate |
| `src/machines/pm.ts` | `pmMachine` (§5.4) | contracts, xstate |
| `src/machines/run.ts` | `runMachine` (§5.2); spawns phases, invokes the PM and stage agents | contracts, xstate |
| `src/hc/` | parsing `hc events --json` into `AgentObservation`s; later the real hc effects | contracts |
| `src/daemon/` | owns run actors: persistence (`machine.json`), event log (`events.jsonl`), projection (`view.json`), socket | xstate, contracts |
| `src/cli/` | `bdc` commands; talk to the daemon over the socket | daemon client |
| `src/effects/` | real implementations of the injected actors (hc, git, verification, MCP); slice 2+ | |
| `herdr-app/` | gpui-kit mods; slice 5+ | |

## Rules

1. **Machines are pure.** Every side effect is a named actor in `setup({ actors })` whose default implementation throws `new Error('<name> not provided')`. The daemon and tests supply implementations with `machine.provide({ actors })`. No `fs`, `child_process`, timers outside XState `after`, or `Date.now()` in machine files; time comes from `after` delays or from inputs.
2. **Context is JSON.** Machine context must survive `JSON.stringify` → `JSON.parse` unchanged (it is persisted, §5.7). No `Map`, `Set`, `Date`, class instances or functions.
3. **Restore-safe.** XState restarts invocations on restore. Every invoked effect must be idempotent: launching an agent re-attaches by `job.key`; git steps check before acting.
4. **Typed setup.** `setup({ types: { context, events, input, output }, actors, actions, guards })`. Guards and actions are named, never inline lambdas in transitions (so tests and diagrams name them).
5. **Children talk with events.** Child → parent with `sendParent`; parent → child with `sendTo(id)`. Event shapes are in `src/contracts/events.ts`. Do not invent new cross-actor events without adding them there.
6. **People words live in the projection**, not in machines. Machines use ids and enums.
7. **Tests**: vitest, in `tests/` mirroring `src/`. Each machine has (a) a test per transition, (b) a test that every event is either handled or deliberately ignored in every state, (c) path coverage with `@xstate/graph` (`getShortestPaths`), (d) persist → JSON round trip → restore → continue for every non-final state, asserting no effect runs twice. The suite never touches the real hc or Herdr app (`HC_SOCKET` points nowhere in `vitest.config.ts`).
8. `npm run check` (typecheck + tests) must pass before anything merges.

## Commits

Small commits with a subject saying what changed and a body saying why. Do not commit generated files, `node_modules`, `dist`, or `.test-home`.
