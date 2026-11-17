// Reviews (spec §8.1, §4.5): every finding of the run and what happened to it. This is also the
// screen the run's final review opens into. A stub: one row per finding with severity, lens,
// phase, summary and status; "No findings yet" when there are none. Worker 3 fills in the
// filters, the finding detail with its fix commit, and the per-lens run status.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";

export function render(view, ctx) {
  const t = ctx.t;
  const phases = view?.phases ?? [];
  const rows = [];
  for (const finding of view?.finalFindings ?? []) rows.push(findingRow(t, finding, "whole run"));
  for (const phase of phases) for (const finding of phase.findings) rows.push(findingRow(t, finding, phase.title));
  return v_flex()
    .id("bdc-reviews")
    .gap(12)
    .child(div().text_size(20).font_semibold().child("Reviews"))
    .child(t.label(view?.stageWords ?? "Waiting for the run…", { color: t.colors.muted }))
    .when(rows.length > 0, (column) => column.child(t.card(t.section(`${rows.length} finding${rows.length === 1 ? "" : "s"}`), ...rows)))
    .when(rows.length === 0, (column) => column.child(t.card(t.label("No findings yet."))))
    .child(t.label("Coming next: filters by lens, phase, severity and status, and opening a finding for its text, the code it points at and the fix that answered it.", { color: t.colors.dim, size: t.type.small }));
}

function findingRow(t, finding, where) {
  const blocking = finding.severity === "critical" || finding.severity === "high";
  return h_flex()
    .id(`bdc-finding-${where}-${finding.id}`)
    .gap(8)
    .items_center()
    .child(t.pill(finding.severity, blocking ? "blocked" : "dim"))
    .child(t.label(finding.lens, { color: t.colors.dim, size: t.type.small }))
    .child(div().flex_1().text_size(t.type.ui).text_color(t.colors.fg).child(finding.summary))
    .child(t.label(where, { color: t.colors.dim, size: t.type.small }))
    .child(t.pill(finding.status, finding.status === "fixed" ? "pass" : finding.status === "open" ? "working" : "dim"));
}
