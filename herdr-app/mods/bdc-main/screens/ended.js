// Ended (spec §9.3, §4.7 "Retry"): the run is done, failed or cancelled. Done shows where the
// pull request went; failed shows the error and offers Retry; cancelled says what was kept.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const stage = view?.stage ?? "done";
  const title = stage === "failed" ? "The run failed" : stage === "cancelled" ? "The run was cancelled" : "Done";
  const pullRequest = view?.pullRequest ?? null;
  return v_flex()
    .id("bdc-ended")
    .gap(12)
    .child(div().text_size(22).font_semibold().child(title))
    .child(t.label(view?.stageWords ?? "", { color: t.colors.muted }))
    .when(stage === "failed" && view?.error !== null && view?.error !== undefined, (column) =>
      column.child(t.card(t.section("What went wrong"), t.label(view.error ?? "", { color: t.colors.blocked }))),
    )
    .when(stage === "done", (column) =>
      column.child(
        t.card(
          t.section("Pull request"),
          t.label(pullRequest === null ? "No pull request was recorded." : pullRequest.url ?? "Written to the project's pull-request file.", { color: t.colors.fg }),
        ),
      ),
    )
    .when(stage === "cancelled", (column) =>
      column.child(t.card(t.label("The agents were stopped. Every branch the run made is still there, so nothing that was built is lost.", { color: t.colors.muted }))),
    )
    .when(stage === "failed", (column) =>
      column.child(
        h_flex()
          .gap(8)
          .child(t.button("Retry", { id: "bdc-retry", primary: true }).on_click((_event, cx) => retry(ctx, cx)))
          .child(t.label("Retry re-enters the step that failed, not the whole stage.", { color: t.colors.dim, size: t.type.small })),
      ),
    )
    .when(stage === "cancelled", (column) => column.child(t.label("Start a new run from the Goal screen when you want to try again.", { color: t.colors.dim, size: t.type.small })));
}

function retry(ctx, cx) {
  ctx.setState({ retrying: true }, cx);
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send({ type: "RETRY" });
    ctx.setState({ retrying: false, error: outcome.ok ? "" : outcome.error }, asyncCx);
  });
}
