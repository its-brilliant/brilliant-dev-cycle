// Ship (spec §4.6, §9.3 "Ship", frame 07): the pull request as bdc will write it from the run's
// evidence, the choice between a draft and a ready pull request, and the one primary action —
// Open pull request (`OPEN_PR {draft}`, §5.6). When the run is done it says where the pull request
// went and offers the next run.
//
// The run's view does not carry the project's pull-request targets yet (`RunView` has no
// `prTargets`), so this screen says where bdc opens it in the project's own words instead of
// naming a target it cannot read.
import { div } from "gpui-kit";
import { Link, h_flex, v_flex } from "gpui-base";
import { previewSections, pullRequestTitle, whereItWent } from "./ship-preview.js";

export function render(view, ctx) {
  const t = ctx.t;
  if (view === null) return v_flex().id("bdc-ship").gap(10).child(t.label("Reading the run…", { color: t.colors.dim }));
  const shipping = view.stage === "shipping";
  const done = view.stage === "done";
  const sections = previewSections(view);
  return v_flex()
    .id("bdc-ship")
    .flex_1()
    .min_h(0)
    .gap(12)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().text_size(20).font_semibold().child("Ship"))
        .child(t.label(view.stageWords, { color: t.colors.muted }))
        .child(div().flex_1())
        .when(shipping && view.needsYou, (row) => row.child(t.pill("needs you", "blocked"))),
    )
    .when(shipping, (column) => column.children(openRows(t, ctx)))
    .when(done, (column) => column.child(doneCard(t, view, ctx)))
    .child(
      v_flex()
        .id("bdc-ship-preview")
        .flex_1()
        .min_h(0)
        .gap(12)
        .overflow_y_scrollbar()
        .child(titleCard(t, view, shipping, done, ctx))
        .when(shipping, (column) => column.child(targetCard(t)))
        .children(sections.map((section) => sectionCard(t, section))),
    );
}

/** The pull request's title, and the one line that says what goes into its body (§4.6). */
function titleCard(t, view, shipping, done, ctx) {
  const draft = ctx.state.draft !== false;
  const badge = done ? "opened" : shipping ? (draft ? "draft" : "ready for review") : "not yet";
  const tone = done ? "pass" : shipping ? (draft ? "dim" : "accent") : "dim";
  return t.card(
    t.section("Pull request"),
    h_flex()
      .gap(10)
      .items_center()
      .child(div().flex_1().min_w(0).text_size(t.type.title).text_color(t.colors.fg).child(pullRequestTitle(view.goal)))
      .child(t.pill(badge, tone)),
    t.label("Its body is written from the run's evidence: the phases and how they ended, the findings and every override with its reason, and each phase's proof.", {
      color: t.colors.dim,
      size: t.type.small,
    }),
  );
}

/** Where the pull request goes, in the project's own terms (§4.6: a file, or GitHub). */
function targetCard(t) {
  return t.card(
    t.section("Where it goes"),
    t.label("bdc opens it where the project's bdc.yaml points: a file in the project, or a repository on GitHub.", { color: t.colors.muted }),
  );
}

/** Draft or ready, then Open pull request — the one thing the run waits for here (§9.1 rule 2). */
function openRows(t, ctx) {
  const draft = ctx.state.draft !== false;
  const sending = ctx.state.sending === true;
  const rows = [
    h_flex()
      .gap(8)
      .items_center()
      .child(choice(t, "Draft", draft, "bdc-ship-draft", (_event, cx) => ctx.setState({ draft: true }, cx)))
      .child(choice(t, "Ready for review", !draft, "bdc-ship-ready", (_event, cx) => ctx.setState({ draft: false }, cx)))
      .child(
        t
          .button("Open pull request", {
            id: "bdc-ship-open",
            primary: true,
            disabled: sending || ctx.readOnly === true,
            reason: ctx.readOnly === true ? "This run has moved on; open Ship again to do this" : "The pull request is opening",
          })
          .on_click((_event, cx) => openPullRequest(ctx, draft, cx)),
      )
      .child(t.label(draft ? "A draft can be marked ready on GitHub later." : "A ready pull request asks for review now.", { color: t.colors.dim, size: t.type.small })),
  ];
  if (sending) rows.push(t.label("Opening the pull request…", { color: t.colors.dim, size: t.type.small }));
  if (typeof ctx.state.error === "string" && ctx.state.error !== "") rows.push(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.error));
  return rows;
}

function choice(t, label, active, id, onClick) {
  return h_flex()
    .id(id)
    .h(26)
    .px(9)
    .items_center()
    .rounded(t.radii.button)
    .border(1)
    .border_color(active ? t.colors.accent : t.colors.border)
    .bg(active ? t.colors.selection : t.colors.bg)
    .cursor_pointer()
    .hover((style) => style.bg(t.colors.raised))
    .on_click(onClick)
    .child(div().text_size(t.type.small).text_color(active ? t.colors.fg : t.colors.muted).child(label));
}

/** One section of the body: each row's badge, what it says and the line under it. */
function sectionCard(t, section) {
  const rows =
    section.rows.length === 0
      ? [t.label(section.empty, { color: t.colors.dim })]
      : section.rows.map((row) =>
          h_flex()
            .id(`bdc-ship-${row.key}`)
            .gap(8)
            .items_start()
            .child(t.pill(row.badge, row.tone))
            .child(
              v_flex()
                .flex_1()
                .min_w(0)
                .gap(2)
                .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(row.text))
                .when(row.note !== "", (column) => column.child(t.label(row.note, { color: t.colors.dim, size: t.type.small }))),
            ),
        );
  return t.card(t.section(section.heading), ...rows);
}

/** Done (§4.6): where the pull request went, and the way to the next run. */
function doneCard(t, view, ctx) {
  const went = whereItWent(view.pullRequest);
  const rows = [t.section("Where it went")];
  if (went.url !== "") {
    rows.push(
      h_flex().child(
        Link.new("bdc-ship-link")
          .href(went.url)
          .child(div().text_size(t.type.ui).text_color(t.colors.accent).child(went.url)),
      ),
    );
  } else {
    rows.push(div().text_size(t.type.ui).text_color(t.colors.fg).child(went.words));
  }
  if (went.path !== "") rows.push(t.label("bdc wrote the pull request into the project; open that file to read it.", { color: t.colors.dim, size: t.type.small }));
  rows.push(
    h_flex()
      .gap(8)
      .items_center()
      .child(t.button("Start another run", { id: "bdc-ship-another", primary: true }).on_click((_event, cx) => ctx.go("goal", {}, cx)))
      .child(t.label("It starts from a new goal; this run's branches and folder stay as they are.", { color: t.colors.dim, size: t.type.small })),
  );
  return t.card(...rows);
}

/** One person event through `bdc send`; a refusal is shown inline, never thrown (§9.1 rule 3). */
function openPullRequest(ctx, draft, cx) {
  ctx.setState({ sending: true, error: "" }, cx);
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send({ type: "OPEN_PR", draft });
    ctx.setState({ sending: false, error: outcome.ok ? "" : outcome.error }, asyncCx);
  });
}
