// Ended (spec §9.3, §4.7): the run is done, failed or cancelled. Done says where the pull request
// went; failed says what went wrong and offers Retry (`RETRY`, which re-enters the step that
// failed, not the stage); cancelled says what is still there and offers the next run.
import { div } from "gpui-kit";
import { Link, h_flex, v_flex } from "gpui-base";
import { joinWords } from "../kit/words.js";
import { phasesDone } from "./build-board.js";
import { whereItWent } from "./ship-preview.js";

export function render(view, ctx) {
  const t = ctx.t;
  const stage = view?.stage ?? "done";
  const title = stage === "failed" ? "The run stopped with a problem" : stage === "cancelled" ? "Cancelled" : "Done";
  return v_flex()
    .id("bdc-ended")
    .flex_1()
    .min_h(0)
    .gap(12)
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(div().text_size(22).font_semibold().child(title))
        .when(view !== null, (row) => row.child(t.label(view.stageWords, { color: t.colors.muted }))),
    )
    .child(v_flex().flex_1().min_h(0).gap(12).overflow_y_scrollbar().children(cards(t, view, stage, ctx)));
}

function cards(t, view, stage, ctx) {
  if (view === null) return [t.card(t.label("Reading the run…", { color: t.colors.dim }))];
  if (stage === "failed") return failedCards(t, view, ctx);
  if (stage === "cancelled") return cancelledCards(t, view, ctx);
  return doneCards(t, view, ctx);
}

/** What went wrong, where, and Retry — the one action the run waits for (§4.7). */
function failedCards(t, view, ctx) {
  const rows = [
    t.card(
      t.section("What went wrong"),
      div().text_size(t.type.ui).text_color(t.colors.blocked).child(view.error === null || view.error === "" ? "bdc did not record why it stopped." : view.error),
      t.label(whereWords(view), { color: t.colors.dim, size: t.type.small }),
    ),
  ];
  const actions = [];
  if (ctx.readOnly !== true) {
    actions.push(
      t
        .button("Retry", { id: "bdc-retry", primary: true, disabled: ctx.state.sending === true })
        .on_click((_event, cx) => retry(ctx, cx)),
    );
  }
  actions.push(t.button("Start another run", { id: "bdc-ended-another" }).on_click((_event, cx) => ctx.go("goal", {}, cx)));
  rows.push(
    h_flex()
      .gap(8)
      .items_center()
      .children(actions)
      .child(t.label("Retry picks up from the step that failed, not from the start.", { color: t.colors.dim, size: t.type.small })),
  );
  if (ctx.state.sending === true) rows.push(t.label("Retrying…", { color: t.colors.dim, size: t.type.small }));
  if (typeof ctx.state.error === "string" && ctx.state.error !== "") rows.push(div().text_size(t.type.small).text_color(t.colors.blocked).child(ctx.state.error));
  return rows;
}

/** Where it stopped: the phases that were left stopped, or the step the error came from. */
function whereWords(view) {
  const stopped = (view.phases ?? []).filter((phase) => phase.state === "stopped" || phase.state === "cancelled").map((phase) => phase.id);
  if (stopped.length > 0) return `It stopped in ${joinWords(stopped)}.`;
  return "bdc kept the step it failed in, so Retry goes back to it.";
}

/** What is still there after a cancel: every branch, and the phases that had finished (§4.7). */
function cancelledCards(t, view, ctx) {
  const done = phasesDone(view.phases ?? []);
  return [
    t.card(
      t.section("What is still there"),
      t.label("The agents were stopped. Every branch the run made is still there, so nothing that was built is lost.", { color: t.colors.muted }),
      t.label(done.total === 0 ? "No phase had started." : `${done.words}; their work is on the run's branches.`, { color: t.colors.dim, size: t.type.small }),
    ),
    h_flex()
      .gap(8)
      .items_center()
      .child(t.button("Start another run", { id: "bdc-ended-another", primary: true }).on_click((_event, cx) => ctx.go("goal", {}, cx)))
      .child(t.label("A new run starts from a new goal; this one stays as it is.", { color: t.colors.dim, size: t.type.small })),
  ];
}

/** Done: where the pull request went, and the next run (§4.6). */
function doneCards(t, view, ctx) {
  const went = whereItWent(view.pullRequest);
  const rows = [t.section("Where it went")];
  if (went.url !== "") {
    rows.push(h_flex().child(Link.new("bdc-ended-link").href(went.url).child(div().text_size(t.type.ui).text_color(t.colors.accent).child(went.url))));
  } else {
    rows.push(div().text_size(t.type.ui).text_color(t.colors.fg).child(went.words));
  }
  if (went.path !== "") rows.push(t.label("bdc wrote the pull request into the project; open that file to read it.", { color: t.colors.dim, size: t.type.small }));
  return [
    t.card(...rows),
    h_flex()
      .gap(8)
      .items_center()
      .child(t.button("Start another run", { id: "bdc-ended-another", primary: true }).on_click((_event, cx) => ctx.go("goal", {}, cx)))
      .child(t.label("It starts from a new goal; this run's branches and folder stay as they are.", { color: t.colors.dim, size: t.type.small })),
  ];
}

/** `RETRY` with no phase: the run re-enters the step it failed in (§5.2, §5.6). */
function retry(ctx, cx) {
  ctx.setState({ sending: true, error: "" }, cx);
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.send({ type: "RETRY" });
    ctx.setState({ sending: false, error: outcome.ok ? "" : outcome.error }, asyncCx);
  });
}
