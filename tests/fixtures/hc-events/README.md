# Recorded hc event logs

Real `hc events --json` output (herdr-core 0.1.21) from a bdc v1 smoke run on 16 Nov 2026, one file per agent terminal. Agents were started through `bdc-adapt`, which reports `working` with `app=bdc` before the CLI starts.

| File | Agent | How it ended |
|---|---|---|
| claude-spec-done.jsonl | claude (Opus 5.5), spec writer | wrote its file, turn `done` |
| claude-planner-done.jsonl | claude, planner | wrote its file, turn `done` |
| pi-builder-done.jsonl | pi, builder | committed; note the startup `idle` (app=pi) right after the `app=bdc` launch marker, before any work |
| claude-reviewer-done.jsonl | claude, reviewer | wrote its findings, turn `done` |
| claude-pm-killed-mid-turn.jsonl | claude, PM | killed while `working` (terminal finished, no result) |

The agent machine's completion rules (spec §3.3) are tested against these, not against hand-written events.
