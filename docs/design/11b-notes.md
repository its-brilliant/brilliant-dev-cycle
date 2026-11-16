# Frame 11b — New project: repo + worktree

Replaces the folder-first dialog in frame 11. Frame 11c is the first-run that follows Create (frame 12, updated for a worktree).

## What 11b replaces in frame 11

- The single **Folder** field, **Choose folder…**, and **repo found, clean** line.
- The note *“bdc adds bdc.yaml and .herd/ to this folder. Nothing else in the repo changes, and no branch is created until a run starts.”*
- The idea that a project is “the folder you already have.” A project is now a **worktree + branch** of a selected repo.
- The sidebar is no longer a flat list of spaces. Under each machine, **projects are grouped by repo**, and each row is one worktree (name + `bdc/<name>` + status).

Kept from frame 11: the + menu (copy updated), close ×, This Mac / contabo radio cards, Cancel, and a primary confirm (now **Create project**).

## Behaviour

**Create project** (on This Mac, local repo already checked out):

```sh
git worktree add -b bdc/<name> <path> <base>
bdc init <path>
```

Then open a Herdr space on `<path>`, named `<name>`, and show first-run (11c). `bdc.yaml` and `.herd/` are written in the worktree only. The main checkout is left alone.

- `<name>` is the project name field, defaulting to a slug (editable, optional). If the field is empty, slug from the repo (`brilliant-ai`) plus a disambiguator if needed.
- Branch is always `bdc/<name>` from the selected base (default `main`, the repo’s default branch). The `bdc/` prefix is fixed.
- `<path>` defaults to `~/bdc/worktrees/<repo>/<name>` (e.g. `~/bdc/worktrees/brilliant-ai/sso-login`). **Change** opens a folder picker.
- On **contabo**, the same commands run on that machine. The repo must already be present there (or cloned there first).

**If the chosen GitHub repo is not local:** clone it first to the “clone to” path shown in the picker (default `~/src/<repo>`), then `git worktree add` from that clone. Do not `bdc init` in the clone, only in the worktree.

**Repo list sources**

- **Recent on This Mac:** local git checkouts this machine has opened or used (path, current branch, clean/dirty).
- **GitHub:** repos for the signed-in GitHub account (OAuth already works), including org repos. Show a private badge and a “clone to” path when the repo is not on disk yet.
- **Choose a local folder…:** native folder picker. The folder must be a git repo (or contain one). After it’s chosen, it is selected like a Recent row.
- Search filters all three, and accepts a pasted `github.com/org/repo` or `org/repo` URL.

**Name collisions**

- If `bdc/<name>` already exists on the repo, or `<path>` already exists, do not overwrite. Suggest the next free slug (`sso-login-2`) in the name field and show a short inline note. The person can edit the name or the path.
- If a space with that name already exists on the same machine, append the same disambiguator.

**Cancel**

- If the person cancels the dialog, do nothing. No clone, no worktree, no branch, no `bdc init`.
- If Create fails midway (e.g. `worktree add` succeeded, `bdc init` failed): remove the new worktree (`git worktree remove <path>`) and delete the new `bdc/<name>` branch. Leave any clone that already existed. If this Create *just* cloned the GitHub repo, remove that clone too.

**Sidebar**

- After Create, the new project appears under its repo group with a **new** badge, selected, showing branch `bdc/<name>`.
- Existing worktrees of the same repo stay listed, so several cycles can share a repo without sharing a working tree.
