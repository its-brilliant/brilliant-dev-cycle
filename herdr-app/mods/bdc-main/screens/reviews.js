// Reviews (spec §8.1, §4.5): every finding of the run in one list — each phase's and the
// whole-run review's — with what happened to each, the filters over them, and a finding opened for
// its full text, the fix it suggests and the reason it was continued or overridden. This is also
// the screen the run's final review opens into.
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { allFindings, blocksNow, countWords, detailRows, fileLine, filterFindings, filterValues, severityTone, statusTone, statusWords } from "./reviews-filters.js";

/** The filter rows, in the order they are offered; `all` is the chip that clears the dimension. */
const DIMENSIONS = [
  { key: "lens", label: "lens", all: "All lenses" },
  { key: "phase", label: "phase", all: "All phases" },
  { key: "severity", label: "severity", all: "All severities" },
  { key: "status", label: "status", all: "All statuses" },
];

export function render(view, ctx) {
  const t = ctx.t;
  const rows = view === null ? [] : allFindings(view);
  const values = filterValues(rows);
  const shown = filterFindings(rows, filtersOf(ctx.state));
  const open = Array.isArray(ctx.state.open) ? ctx.state.open : [];
  return v_flex()
    .id("bdc-reviews")
    .flex_1()
    .min_h(0)
    .gap(10)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().text_size(20).font_semibold().child("Reviews"))
        .child(t.label(view?.stageWords ?? "Waiting for the run", { color: t.colors.muted }))
        .child(div().flex_1())
        .when(rows.length > 0, (row) => row.child(t.label(countWords(shown), { color: t.colors.dim, size: t.type.small }))),
    )
    .when(rows.length > 0, (column) => column.child(filters(t, rows, values, ctx)))
    .when(shown.length > 0, (column) =>
      column.child(v_flex().id("bdc-findings").flex_1().min_h(0).gap(6).overflow_y_scrollbar().children(shown.map((row) => findingRow(t, row, open.includes(row.key), ctx)))),
    )
    .when(rows.length > 0 && shown.length === 0, (column) =>
      column.child(
        t.card(
          t.label("No finding matches these filters.", { color: t.colors.muted }),
          h_flex().child(t.button("Show them all", { id: "bdc-findings-clear" }).on_click((_event, cx) => ctx.setState(clearFilters(), cx))),
        ),
      ),
    )
    .when(rows.length === 0, (column) => column.child(t.card(t.label("No findings yet.", { color: t.colors.muted }))));
}

/** The filters as the screen holds them; a missing value is "all". */
function filtersOf(state) {
  return {
    lens: typeof state.lens === "string" ? state.lens : "",
    phase: typeof state.phase === "string" ? state.phase : "",
    severity: typeof state.severity === "string" ? state.severity : "",
    status: typeof state.status === "string" ? state.status : "",
    onlyBlocking: state.onlyBlocking === true,
  };
}

/** Clearing every filter at once, for the way out of an empty list. */
function clearFilters() {
  return { lens: "", phase: "", severity: "", status: "", onlyBlocking: false };
}

/**
 * One row per filter dimension, offered only when it has something to choose (§9.1 rule 3), plus
 * "Only what blocks" when something does.
 */
function filters(t, rows, values, ctx) {
  const chosen = filtersOf(ctx.state);
  const lines = [];
  for (const dimension of DIMENSIONS) {
    const options = dimension.key === "phase" ? values.phase.map((phase) => ({ value: phase.id, label: phase.label })) : values[dimension.key].map((value) => ({ value, label: dimension.key === "status" ? statusWords(value) : value }));
    if (options.length < 2) continue;
    lines.push(
      h_flex()
        .gap(6)
        .items_center()
        .flex_wrap()
        .child(div().w(56).text_size(t.type.tiny).text_color(t.colors.dim).child(dimension.label))
        .child(chip(t, dimension.all, chosen[dimension.key] === "", `bdc-filter-${dimension.key}-all`, (_event, cx) => ctx.setState({ [dimension.key]: "" }, cx)))
        .children(
          options.map((option) =>
            chip(t, option.label, chosen[dimension.key] === option.value, `bdc-filter-${dimension.key}-value-${slug(option.value)}`, (_event, cx) =>
              ctx.setState({ [dimension.key]: chosen[dimension.key] === option.value ? "" : option.value }, cx),
            ),
          ),
        ),
    );
  }
  if (rows.some((row) => blocksNow(row.finding))) {
    lines.push(
      h_flex()
        .gap(6)
        .items_center()
        .child(div().w(56).text_size(t.type.tiny).text_color(t.colors.dim).child("show"))
        .child(chip(t, "Only what blocks", chosen.onlyBlocking, "bdc-filter-blocking", (_event, cx) => ctx.setState({ onlyBlocking: !chosen.onlyBlocking }, cx))),
    );
  }
  return v_flex().id("bdc-filters").gap(6).children(lines);
}

function chip(t, label, active, id, onClick) {
  return h_flex()
    .id(id)
    .h(22)
    .px(7)
    .items_center()
    .rounded(t.radii.chip)
    .border(1)
    .border_color(active ? t.colors.accent : t.colors.border)
    .bg(active ? t.colors.selection : t.colors.bg)
    .cursor_pointer()
    .hover((style) => style.bg(t.colors.raised))
    .on_click(onClick)
    .child(div().text_size(t.type.tiny).text_color(active ? t.colors.fg : t.colors.muted).child(label));
}

/** One finding: severity, lens, where it came from, what it says, the code it points at, its status. */
function findingRow(t, row, isOpen, ctx) {
  const finding = row.finding;
  const place = fileLine(finding);
  const open = Array.isArray(ctx.state.open) ? ctx.state.open : [];
  return v_flex()
    .id(`bdc-finding-${row.key}`)
    .gap(6)
    .p(8)
    .rounded(t.radii.chip)
    .border(1)
    .border_color(isOpen ? t.colors.accent : t.colors.border)
    .bg(t.colors.bg)
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .cursor_pointer()
        .on_click((_event, cx) => ctx.setState({ open: open.includes(row.key) ? open.filter((key) => key !== row.key) : [...open, row.key] }, cx))
        .child(t.pill(finding.severity, severityTone(finding.severity)))
        .child(div().w(96).text_size(t.type.small).text_color(t.colors.dim).truncate().child(finding.lens))
        .child(div().w(160).text_size(t.type.small).text_color(t.colors.muted).truncate().child(row.where))
        .child(div().flex_1().min_w(0).text_size(t.type.ui).text_color(t.colors.fg).when(!isOpen, (element) => element.truncate()).child(finding.summary))
        .when(place !== "", (line) => line.child(div().text_size(t.type.tiny).font_family(t.mono).text_color(t.colors.dim).child(place)))
        .child(t.pill(statusWords(finding.status), statusTone(finding.status))),
    )
    .when(isOpen, (column) =>
      column.child(
        v_flex()
          .gap(4)
          .child(div().text_size(t.type.ui).text_color(t.colors.muted).child(finding.summary))
          .when(place !== "", (detail) => detail.child(div().text_size(t.type.tiny).font_family(t.mono).text_color(t.colors.dim).child(place)))
          .children(
            detailRows(finding).map((detail) =>
              h_flex()
                .gap(8)
                .items_start()
                .child(div().w(150).text_size(t.type.tiny).text_color(t.colors.dim).child(detail.label))
                .child(div().flex_1().min_w(0).text_size(t.type.small).text_color(t.colors.muted).child(detail.text)),
            ),
          ),
      ),
    );
}

/** An element id from a value the run chose, so two filters cannot share one. */
function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-");
}
