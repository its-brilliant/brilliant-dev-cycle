// Ship (spec §4.6, §9.3 "Ship", frame 07): the PR preview, its target, Open pull request. A stub:
// it says whether the pull request is opened and where. Worker 3 fills in the preview, the
// targets and the Open pull request button.
import { div } from "gpui-kit";
import { v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const pullRequest = view?.pullRequest ?? null;
  const where = pullRequest === null ? "not opened yet" : pullRequest.url ?? "written to the project's pull-request file";
  return v_flex()
    .id("bdc-ship")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Ship"))
    .child(t.label(view?.stageWords ?? "Waiting for the run…", { color: t.colors.muted }))
    .child(
      t.card(
        t.section("Pull request"),
        t.label(where, { color: t.colors.fg }),
        t.label("Its body is written from the evidence: the spec, the phases, the checks, the findings and every override with who made it and why.", { color: t.colors.dim, size: t.type.small }),
      ),
    )
    .child(t.label("Coming next: the pull request preview, its targets (a file here or a GitHub repo), and Open pull request as a draft or ready.", { color: t.colors.dim, size: t.type.small }));
}
