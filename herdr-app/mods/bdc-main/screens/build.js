// Build (spec §4.4, §9.3 "Build (Progress)", frame 03): what runs, what waits on you. A stub: one
// row per phase with its words, its verification and its findings count, and a click into the
// phase detail. Worker 3 fills in the DAG and the per-phase step tracks.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const phases = view?.phases ?? [];
  const rows = phases.map((phase) => {
    const findings = phase.findings.length;
    const checks = phase.verification === null ? null : phase.verification.steps.filter((step) => step.exitCode === 0).length;
    const facts = [
      findings === 0 ? "" : `${findings} finding${findings === 1 ? "" : "s"}`,
      checks === null ? "" : `${checks} of ${phase.verification.steps.length} checks pass`,
      `${phase.attemptsUsed} attempt${phase.attemptsUsed === 1 ? "" : "s"}`,
    ].filter((fact) => fact !== "");
    return h_flex()
      .id(`bdc-phase-${phase.id}`)
      .gap(10)
      .items_center()
      .p(10)
      .rounded(t.radii.panel)
      .border(1)
      .border_color(t.colors.border)
      .bg(t.colors.bg)
      .cursor_pointer()
      .hover((style) => style.bg(t.colors.raised))
      .on_click((_event, cx) => ctx.go("phase", { phaseId: phase.id }, cx))
      .child(div().w(28).text_size(t.type.tiny).text_color(t.colors.dim).child(phase.id))
      .child(v_flex().flex_1().gap(2).child(div().text_size(t.type.ui).text_color(t.colors.fg).child(phase.title)).child(t.label(facts.join(" · "), { color: t.colors.dim, size: t.type.small })))
      .child(t.pill(phase.words, phase.needsYou ? "blocked" : phase.state === "done" ? "pass" : "working"));
  });
  return v_flex()
    .id("bdc-build")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Build"))
    .child(t.label(view?.stageWords ?? "Building…", { color: t.colors.muted }))
    .when(rows.length > 0, (column) => column.child(v_flex().gap(6).children(rows)))
    .when(view !== null && rows.length === 0, (column) => column.child(t.card(t.label("No phases yet."))))
    .child(t.label("Coming next: the phase DAG, each phase's step track, and opening a phase for its detail.", { color: t.colors.dim, size: t.type.small }));
}
