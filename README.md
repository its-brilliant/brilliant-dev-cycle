# brilliant-dev-cycle

`bdc` is the orchestrator CLI for brilliant-dev-cycle. This repository is at **p1-core**: the `bdc.yaml` parser, the `.herd/` file model, and `bdc validate`.

The CLI is TypeScript. It talks to Herdr through files. The same schema is what the JavaScript layout mods and the later Cloudflare Worker will import. Herdr's own process stays a separate Rust program.

Later phases (Herdr bridge, the phase runner, layout mods, hosted mode) are not in this build. See `docs/spec.md` and `docs/phases.yaml`.

## Requirements

Node.js 22 or newer.

## Develop

```sh
npm ci
make test
export PATH="$PWD/bin:$PATH"
bdc validate examples/demo
```

`make lint` typechecks and runs ESLint. `make test` runs the unit tests and validates `examples/demo`.

## Validate

`bdc validate <dir>` checks:

- `bdc.yaml` — agent roles and custom commands, concurrency, max_envs, max_attempts, reviewers (`block_on`: any, low, medium, high, none), keep_envs, GitHub and GitLab PR targets, env up/down scripts, and verify (setup or setup_md, checks that are `run` or `agent`, evidence)
- `.herd/spec.vN.md` and line-anchored `comments/spec.vN.jsonl`
- `.herd/phases.yaml` — including unknown dependencies and cycles
- `.herd/reviewers/<lens>.md`
- `.herd/runs/<id>/` when a run is present (state, questions, review records)

Error lines include the file and the field path. `.herd/runs/` is gitignored because logs may contain secrets.

An operator override of a blocking reviewer is a data record (`who`, `reviewer`, `reason`). The ship flow that writes it onto a PR is a later phase.

## License

Apache-2.0. See [LICENSE](LICENSE).
