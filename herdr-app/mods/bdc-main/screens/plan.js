// Plan (spec §4.3, §9.3 "Plan", frame 02): see the phase DAG, approve. A stub: the phases with
// their dependencies, tasks and checks, which is what the DAG is drawn from. Worker 2 fills in
// the DAG, the per-phase inspector and Approve plan / Request changes.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const phases = view?.plan?.phases ?? [];
  const rows = phases.map((phase) =>
    v_flex()
      .gap(3)
      .child(h_flex().gap(8).items_center().child(div().text_size(t.type.ui).text_color(t.colors.fg).child(phase.title)).child(t.pill(`${phase.tasks.length} task${phase.tasks.length === 1 ? "" : "s"}`, "dim")))
      .child(
        t.label(
          phase.deps.length === 0 ? "Starts first" : `After ${phase.deps.join(", ")}`,
          { color: t.colors.dim, size: t.type.small },
        ),
      )
      .child(t.label(`${phase.checks.length} check${phase.checks.length === 1 ? "" : "s"}, ${phase.proof.length} proof item${phase.proof.length === 1 ? "" : "s"}`, { color: t.colors.dim, size: t.type.small })),
  );
  return v_flex()
    .id("bdc-plan")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Plan"))
    .child(t.label(view?.stageWords ?? "Writing the plan…", { color: t.colors.muted }))
    .when(phases.length > 0, (column) => column.child(t.card(t.section(`${phases.length} phase${phases.length === 1 ? "" : "s"}`), ...rows)))
    .when(view !== null && phases.length === 0, (column) => column.child(t.card(t.label("The planner is working. The phases appear here when it submits."))))
    .child(t.label("Coming next: the phase DAG, the per-phase inspector with its tasks and checks, and Approve plan / Request changes.", { color: t.colors.dim, size: t.type.small }));
}
