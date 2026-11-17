// Goal (spec §9.3 "Goal", frames 11c / 12): the project has no run yet, so the person types what
// they want built and Start creates the run (`bdc start`, spec §7.2). This screen is complete:
// the PM then grills the person in PM chat (§4.1) and the main area moves on to Intake.
import { div } from "gpui-kit";
import { Input, h_flex, v_flex } from "gpui-base";

export function render(_view, ctx) {
  const t = ctx.t;
  const state = ctx.state;
  const input = ctx.inputs.goal;
  const typed = input.value().trim();
  const starting = state.starting === true;
  return v_flex()
    .id("bdc-goal")
    .gap(14)
    .child(div().text_size(22).font_semibold().child("What do you want built?"))
    .child(t.label("Say it in your own words. The PM reads the repo, asks you the questions it cannot answer itself, then writes a spec, a plan and builds it."))
    .child(
      Input.new(input)
        .h(56)
        .px(12)
        .py(10)
        .rounded(t.radii.input)
        .border(1)
        .border_color(typed === "" ? t.colors.input : t.colors.accent)
        .bg(t.colors.bg)
        .text_size(13)
        .text_color(t.colors.fg),
    )
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(
          t
            .button(starting ? "Starting…" : "Start", {
              id: "bdc-goal-start",
              primary: true,
              disabled: starting || typed === "",
              reason: starting ? "The run is starting" : "Type a goal first",
            })
            .on_click((_event, cx) => start(ctx, cx)),
        )
        .when(starting, (row) => row.child(t.label("Creating the run…", { color: t.colors.dim })))
        .when(state.error !== undefined && state.error !== "", (row) => row.child(div().text_size(t.type.small).text_color(t.colors.blocked).child(state.error))),
    )
    .child(t.label("Enter starts too, once the box has a goal and the keyboard is in it.", { color: t.colors.dim, size: t.type.small }));
}

function start(ctx, cx) {
  const goal = ctx.inputs.goal.value().trim();
  if (goal === "" || ctx.state.starting === true) return;
  ctx.setState({ starting: true, error: "" }, cx);
  cx.spawn(async (asyncCx) => {
    const outcome = await ctx.start(goal);
    ctx.setState({ starting: false, error: outcome.ok ? "" : outcome.error }, asyncCx);
    // The run appears through the run watch; nothing else to do here.
  });
}
