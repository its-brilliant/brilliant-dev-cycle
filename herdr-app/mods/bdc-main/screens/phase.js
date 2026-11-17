// Phase detail (spec §4.4, §9.3 "Phase detail", frame 04): one phase — its tasks, review, verify
// steps and the PM's decisions. Opened from Build; `ctx.state.phaseId` says which phase. A stub:
// it shows the phase's words, findings, verification steps and proof. Worker 3 fills in tasks,
// what each builder did, the review detail and the PM decisions.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const phases = view?.phases ?? [];
  const phase = phases.find((candidate) => candidate.id === ctx.state.phaseId) ?? phases[0] ?? null;
  if (phase === null) {
    return v_flex().id("bdc-phase").gap(10).child(div().text_size(20).font_semibold().child("Phase")).child(t.label("Pick a phase on the Build screen to see it here.", { color: t.colors.muted }));
  }
  const findings = phase.findings.map((finding) =>
    h_flex()
      .gap(8)
      .items_center()
      .child(t.pill(finding.severity, finding.severity === "critical" || finding.severity === "high" ? "blocked" : "dim"))
      .child(t.label(finding.lens, { color: t.colors.dim, size: t.type.small }))
      .child(div().flex_1().text_size(t.type.ui).text_color(t.colors.fg).child(finding.summary))
      .child(t.label(finding.status, { color: t.colors.dim, size: t.type.small })),
  );
  const steps =
    phase.verification === null
      ? []
      : phase.verification.steps.map((step) =>
          h_flex()
            .gap(8)
            .items_center()
            .child(t.pill(step.exitCode === 0 ? "passed" : step.exitCode === null ? "not run" : "failed", step.exitCode === 0 ? "pass" : step.exitCode === null ? "dim" : "blocked"))
            .child(div().flex_1().text_size(t.type.small).text_color(t.colors.muted).child(step.name))
            .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(`${Math.round(step.durationMs / 100) / 10}s`)),
        );
  const proof = phase.proof.map((item) =>
    h_flex()
      .gap(8)
      .items_center()
      .child(t.pill(item.kind, "review"))
      .child(div().flex_1().text_size(t.type.small).text_color(t.colors.muted).child(item.shows))
      .child(t.label(item.by === "person" ? "you" : item.by, { color: t.colors.dim, size: t.type.small })),
  );
  return v_flex()
    .id("bdc-phase")
    .gap(12)
    .child(h_flex().gap(10).items_center().child(div().text_size(20).font_semibold().child(phase.title)).child(t.pill(phase.words, phase.needsYou ? "blocked" : "working")))
    .child(t.label(`Attempt ${phase.attemptsUsed}`, { color: t.colors.dim, size: t.type.small }))
    .when(findings.length > 0, (column) => column.child(t.card(t.section("Findings"), ...findings)))
    .when(steps.length > 0, (column) => column.child(t.card(t.section("Checks"), ...steps)))
    .when(proof.length > 0, (column) => column.child(t.card(t.section("Proof"), ...proof)))
    .child(t.label("Coming next: the phase's tasks and what each builder did, the review detail, and the PM's decisions on it.", { color: t.colors.dim, size: t.type.small }));
}
