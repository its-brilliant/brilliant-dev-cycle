# dev-cycle layout — design references

Pixel-match the layout to Brandi's Figma frames on page [dev-cycle layout v1](https://www.figma.com/design/x0p11F0EUz4rJc1qF0siqa).

**Source of truth:** [`docs/design/source/`](source/). That directory holds the exact HTML/CSS the frames were rendered from. Port tokens and classes from [`source/style.css`](source/style.css); do not re-derive them from these PNGs.

The PNGs in [`frames/`](frames/) are 2× exports (3520×2280) of the 1760×1140 artboards, for visual comparison only.

| Frame | Figma node | Panel / tab | Source HTML | Notes |
| --- | --- | --- | --- | --- |
| [frames/01-spec-review.png](frames/01-spec-review.png) | `31:2` | spec-review + pm-chat | [source/01-spec.html](source/01-spec.html) | Spec grilling and review |
| [frames/02-phase-dag.png](frames/02-phase-dag.png) | `33:2` | phase-dag + pm-chat | [source/02-phase-dag.html](source/02-phase-dag.html) | Pre-build edit |
| [frames/03-progress.png](frames/03-progress.png) | `34:2` | progress + pm-chat | [source/03-progress.html](source/03-progress.html) | Mid-run default, including the bdc-bar |
| [frames/04-phase-detail.png](frames/04-phase-detail.png) | `35:2` | phase detail + pm-chat | [source/04-phase-detail.html](source/04-phase-detail.html) | Focused phase, opened from a Progress node |
| [frames/05-verify-config.png](frames/05-verify-config.png) | `38:2` | verify-config + pm-chat | [source/05-verify.html](source/05-verify.html) | |
| [frames/06-reviewers.png](frames/06-reviewers.png) | `39:2` | reviewers + pm-chat | [source/06-reviewers.html](source/06-reviewers.html) | |
| [frames/07-ship.png](frames/07-ship.png) | `40:2` | ship + pm-chat | [source/07-ship.html](source/07-ship.html) | Blocked by a reviewer |
| [frames/08-settings.png](frames/08-settings.png) | `41:2` | settings + pm-chat | [source/08-settings.html](source/08-settings.html) | `08 · bdc-settings` |

Each artboard also shows the Herdr chrome and a pm-chat panel. Drop the `.artboard` / `.caption` / `.window` wrapper from the source HTML; everything inside `.window` is the app.
