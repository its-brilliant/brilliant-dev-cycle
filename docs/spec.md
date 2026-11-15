# brilliant-dev-cycle: spec v0.4 (draft for review)

## What it is
A standalone repo that ships a Herdr app layout (plus its mods) and an orchestrator process.
Together they take a feature from an idea to a PR with evidence:
spec → phases → parallel build → review → verify → final review → PR.

Distribution: users install it as a Herdr layout (published like any shared layout/mod bundle).
The orchestrator is a small CLI (`bdc`) that the layout starts and talks to through files.

## Goals
- The spec is agreed through back-and-forth with an agent, using inline comments (Plannotator-style).
- Phases form a DAG. Each phase can verify itself, and tasks inside a phase run in parallel.
- Every phase gets its own side env, and it must pass its `verify` before dependent phases start.
- Any coding agent Herdr supports can be used (Claude Code, Codex, OpenCode, Pi, Cursor, custom),
  picked per role.
- A PM agent is the user's single point of contact during the run.
- Reviewer agents (perf, security, UX, any custom ones) review before every verify.
- The PR opens only after all phases pass and a final review plus verify pass. It carries all the evidence.

## Non-goals (v1)
- Merging the PR. A human merges.

## Stages
1. **Spec (grill).** The user creates a project and gives a short brief. The spec agent asks questions
   until open questions are empty, then writes `spec.md`. The user comments on lines and the agent replies
   or revises. The stage ends when the user approves a spec version.
2. **Phase breakdown.** The planner agent writes `phases.yaml`: phases with `deps`, parallel `tasks`,
   an `env` and a `verify` block. It's reviewed the same way (comments) and approved.
3. **Build loop**, per ready phase (all deps passed):
   1. Bring up the phase side env (`env.up`).
   2. Run each task in its own git worktree with its own agent, in parallel.
   3. Merge the task branches into the phase branch. Conflicts go back to an agent.
   4. Reviewers run on the phase diff. The orchestrator fixes findings or raises a question to the PM.
   5. Run `verify` against the side env. On failure, fix and retry up to `max_attempts`, then escalate to the PM.
   6. Pass: record evidence, tear down the env (unless `keep_env`), and unlock dependent phases.
4. **Final gate.** After all phases pass: a full reviewer round on the whole diff, then every phase's `verify`
   again on one fresh env.
5. **PR.** Open a PR with the spec link, the phase DAG, reviewer findings and how each was resolved,
   and verify logs and artifacts.

## Agents (roles)
| Role | Job |
|---|---|
| spec | grills the user, writes `spec.md` |
| planner | writes `phases.yaml` |
| orchestrator | runs the DAG (this is the CLI, not an LLM) and calls agents for fixes |
| worker | does one task in one worktree |
| reviewer:<lens> | reviews a diff against `reviewers/<lens>.md` |
| pm | answers the user, holds questions, relays comments to the orchestrator |

Questions never block the whole DAG. A blocked task or phase parks as a pending question,
and other ready phases keep going.

## Agent-agnostic config (`bdc.yaml`)
```yaml
agents:
  default: claude          # any agent Herdr knows (agent manifests), or a custom command
  roles:
    spec: claude
    planner: claude
    worker: codex
    pm: claude
    reviewer: opencode
  custom:
    my-agent: { command: "my-agent --yolo", herdr_manifest: null }
concurrency: 4             # max parallel workers
max_envs: 4                # max side envs up at once; phases queue for an env slot (e.g. Cloudflare Hyperdrive caps)
max_attempts: 3            # verify retries per phase
reviewers:
  security: { block_on: high }   # reviewers can block; block_on = minimum severity that blocks (any|low|medium|high)
  perf:     { block_on: high }
  ux:       { block_on: none }   # advisory only
keep_envs: false            # true keeps each phase's side env up after it passes (counts toward max_envs)
pr_targets:                 # user-defined; the PR opens on each target
  - { provider: github, repo: org/app, base: main, draft: true }
  - { provider: gitlab, project: group/app, base: main }
```
Agents are started through Herdr (`agent.start`, `agent.prompt` with wait), so anything Herdr supports works.

## Side envs and verification
Every phase declares an env. `up` and `down` are user scripts, so this works for any stack:
```yaml
env:
  up: ./scripts/env-up.sh ${PHASE_ID} ${BRANCH}    # prints JSON: {"url": ..., "health": ...}
  down: ./scripts/env-down.sh ${PHASE_ID}
verify:
  setup: ./scripts/verify-setup.sh                   # or setup_md: docs/verify.md (an agent follows it)
  checks:
    - run: pnpm test
    - run: ./scripts/e2e.sh ${ENV_URL}
    - agent: "Open ${ENV_URL} and confirm the export button downloads a CSV"   # agent-run acceptance check
  evidence: [junit.xml, screenshots/]
```

## Files (single source of truth; the UI, orchestrator and PR all read these)
```
.herd/
  spec.md                  # versioned (spec.v1.md, spec.v2.md ...)
  comments/spec.v2.jsonl   # line-anchored comments and replies
  phases.yaml
  reviewers/<lens>.md      # the reviewer's instructions
  runs/<run-id>/
    state.json             # DAG status per phase and task
    questions.jsonl        # pending and answered PM questions
    phases/<id>/review.json, verify.log, evidence/
```

`.herd/runs/` is gitignored by default, since logs may contain secrets. Org-specific setup (env scripts, reviewer
prompts, limits) lives in a separate config pack, never in this public repo.

## Layout (Herdr mods)
Progress · Spec review · Phase DAG · Verification config · Reviewers · PM chat dock.
**Progress view** (the default panel during a run): a stage bar (Spec → Phases → Build → Final review → PR)
with the current stage highlighted, then the DAG colored by status (done, in progress, blocked on a question,
queued for an env slot, not started). Each running phase shows its current step (env up, tasks n/m, review,
verify attempt k), and the header shows totals (phases done/total, tasks done/total, open questions). It reads
`runs/<id>/state.json` only.

The mods watch `.herd/` with `watchFolder`, and they write comments and answers back as files. No extra server.

## Local mode and hosted mode
Same orchestrator and same `.herd/` files in both; only where they live and who can see them changes.

**Local mode (default).** Everything runs on the user's machine inside Herdr. `.herd/` is in the repo
(or `~/.bdc/sessions`). Nothing leaves the machine except agent and PR calls.

**Hosted mode.** The orchestrator runs on a server (one worker per session) and agents run in remote
Herdr servers (Herdr already supports connecting machines and remote sessions). A small sync service stores
the session state and events:
- Each session has an owner, members (viewer / commenter / operator), and a share link.
- The Herdr layout connects to a hosted session the same way it reads local files: the mods read a synced
  copy of `.herd/` and post comments and answers through the sync API. So the UI code is identical.
- Viewers watch the spec, DAG, reviews, verify logs and live agent panes (read-only). Commenters can comment
  on the spec and answer PM questions. Only operators can approve stages, change config or stop the run.
- Secrets (agent keys, env scripts' credentials, PR tokens) stay with the session's runner, never in the
  synced state.
- A local session can be pushed to hosted ("share this session") and continued there.

**Deployment.** Hosted mode is its own self-hostable service in this repo (`hosted/`), not tied to any one
company's backend. Anyone can deploy it to their own Cloudflare account with one command. The target is
Cloudflare: a Worker for the API and auth, one Durable Object per session holding its event log and fanning
out live updates over WebSockets, R2 for evidence artifacts (logs, screenshots), and D1 for users, sessions
and membership. Auth is pluggable (GitHub OAuth by default; Cloudflare Access as an option).

**Phasing.** v1 ships local mode with the file model designed for sync (append-only event log plus
snapshots). Hosted mode comes after, as its own spec.

## Decided (v0.3)
- PR targets are user-defined (`pr_targets`), with any number of targets per project.
- Side envs can stay up when `keep_envs` is set. The default is tear down on pass.
- Reviewers can block, with a per-reviewer severity threshold. An operator can override a block from the ship screen; the override (who, which reviewer, reason) is written into the PR evidence.
- License: Apache-2.0.
- Repo name: `brilliant-dev-cycle`, public.
- Hosted mode is a separate self-hostable service, targeting Cloudflare (Workers, Durable Objects, D1, R2).

## Open questions
None right now.
