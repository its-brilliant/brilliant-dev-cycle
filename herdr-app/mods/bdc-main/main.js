// The main area (spec §9.2, §9.3): one stage-following screen, a stage stepper, Pause/Resume and
// Cancel. It only reads the run's view and sends person events through `bdc` (§7.2).
//
// The screen for the run's stage comes from `screens/<name>.js`, each exporting
// `render(view, ctx)`. That is the whole contract between this router and a screen:
//
//   ctx = {
//     t,             // the look (kit/look.js): colors, type, radii, pill, card, button, section
//     root,          // the project folder, or null
//     target,        // { root, machine, space, name, runId } or null
//     view,          // the same view the screen got, for convenience
//     send(event),   // one person event (spec §5.6) to this run: { ok, error }
//     start(goal),   // `bdc start` for a project with no run: { ok, runId, error }
//     cx,            // this render's context: do not keep it past the render (Herdr's rule)
//     state,         // this screen's own state, `ctx.state[<screen>]` here, plain JSON
//     setState(patch, cx),  // merge into this screen's state and redraw; pass the handler's cx
//     input(name, cx),      // an InputState, created on first use; call from a handler or task
//     inputs,        // the InputStates this mod already made in `init`
//     readOnly,      // the person opened an earlier stage: show it, change nothing
//     go(screen, patch?, cx?), // open another screen (e.g. "phase"), with its state merged
//   }
//
// A screen never imports another screen, keeps its state under its own name, and sets
// `state.editing` while the person is mid-edit: the router then stops following the run and
// offers "Go to <stage>" instead of pulling the screen away.
import { View, div } from "gpui-kit";
import { InputState, h_flex, v_flex } from "gpui-base";
import { BDC } from "./kit/bdc-command.js";
import { bdcCommands } from "./kit/bdc.js";
import { host } from "./kit/host.js";
import { look } from "./kit/look.js";
import { resolveProject, sameTarget } from "./kit/project.js";
import { watchRun } from "./kit/view.js";
import { STEPS, stepOf } from "./kit/words.js";
import * as build from "./screens/build.js";
import * as ended from "./screens/ended.js";
import * as goal from "./screens/goal.js";
import * as intake from "./screens/intake.js";
import * as phase from "./screens/phase.js";
import * as plan from "./screens/plan.js";
import * as reviews from "./screens/reviews.js";
import * as setup from "./screens/setup.js";
import * as ship from "./screens/ship.js";
import * as spec from "./screens/spec.js";

const SCREENS = { build, ended, goal, intake, phase, plan, reviews, setup, ship, spec };

/** The stepper's step names in screen order: the screen a done step opens read-only. */
const STEP_SCREENS = ["intake", "spec", "plan", "build", "reviews", "ship"];

/** The screen the run's stage belongs to (spec §9.2: the main area follows the run). */
export function stageScreen(view) {
  switch (view.stage) {
    case "intake":
      return "intake";
    case "specDrafting":
    case "specReview":
      return "spec";
    case "planning":
    case "planReview":
      return "plan";
    case "building":
      return "build";
    case "finalReview":
      return "reviews";
    case "shipping":
      return "ship";
    case "done":
    case "failed":
    case "cancelled":
      return "ended";
    default:
      return "intake";
  }
}

export default class BdcMain extends View {
  init(_props, cx) {
    this.bdc = bdcCommands(host, BDC);
    this.target = null;
    this.view = null;
    this.watcher = null;
    /** Which screen is open, and whether the person opened it read-only. */
    this.open = { screen: "setup", readOnly: false };
    /** Each screen's own state, keyed by screen name (`ctx.state[<screen>]`). */
    this.state = {};
    /** InputStates, made in `init` because Herdr only makes them in a host call. */
    this.inputs = { goal: InputState.new({ placeholder: "What do you want built?" }) };
    this.follow = true;
    this.error = "";
    this.confirmingCancel = false;
    this.handle = cx.focus_handle();
    // A check loads the mod for real: no timers, no `bdc`, no folder watches.
    if (host.checking()) return;
    cx.timer.every(3000, (timerCx) => this.sync(timerCx));
    this.sync(cx);
  }

  sync(cx) {
    cx.spawn(async (asyncCx) => {
      const next = await resolveProject(host);
      if (sameTarget(this.target, next)) return;
      this.followTarget(next, asyncCx);
    });
  }

  followTarget(next, cx) {
    this.watcher?.stop();
    this.watcher = null;
    this.target = next;
    this.view = null;
    this.open = { screen: next === null ? "setup" : next.runId === null ? "goal" : "intake", readOnly: false };
    this.follow = true;
    this.confirmingCancel = false;
    if (next !== null && next.runId !== null) this.watcher = watchRun(host, cx, next, (view) => this.onView(view));
    cx.notify();
  }

  onView(view) {
    this.view = view;
    if (this.follow && !this.editing()) this.open = { screen: stageScreen(view), readOnly: false };
  }

  /** True while the person is mid-edit on the open screen: the run must not pull it away. */
  editing() {
    return this.state[this.open.screen]?.editing === true;
  }

  async close(_cx) {
    this.watcher?.stop();
    this.watcher = null;
  }

  // ── actions ───────────────────────────────────────────────────────────────────────────────

  /** One person event through `bdc send`; a failure is shown inline, not thrown. */
  send(event, cx) {
    const target = this.target;
    if (target === null) return Promise.resolve({ ok: false, error: "no project" });
    this.error = "";
    if (cx) cx.notify();
    return this.bdc.send(target.root, event, target.runId).then((outcome) => {
      if (!outcome.ok) this.error = outcome.error;
      return outcome;
    });
  }

  openStep(index, cx) {
    const screen = STEP_SCREENS[index];
    if (screen === undefined) return;
    const current = this.view === null ? -1 : stepOf(this.view.stage);
    this.open = { screen, readOnly: index < current };
    this.follow = false;
    cx.notify();
  }

  go(screen, patch, cx) {
    if (patch !== undefined) this.state[screen] = { ...this.state[screen], ...patch };
    this.open = { screen, readOnly: false };
    this.follow = this.view !== null && screen === stageScreen(this.view);
    if (cx) cx.notify();
  }

  input(name, cx) {
    const existing = this.inputs[name];
    if (existing !== undefined) return existing;
    const created = InputState.new({ placeholder: "" });
    this.inputs[name] = created;
    if (cx) cx.notify();
    return created;
  }

  // ── render ────────────────────────────────────────────────────────────────────────────────

  render() {
    const t = look(host.theme());
    const banner = this.banner(t);
    return v_flex()
      .size_full()
      .min_h(0)
      .bg(t.colors.canvas)
      .text_color(t.colors.fg)
      .child(this.header(t))
      .when(banner !== null, (column) => column.child(banner))
      .child(this.screen(t));
  }

  /** Project, stepper, and the two run controls (spec §9.2). */
  header(t) {
    const view = this.view;
    const current = view === null ? -1 : stepOf(view.stage);
    return h_flex()
      .id("bdc-header")
      .flex_none()
      .h(44)
      .px(14)
      .gap(16)
      .items_center()
      .border(1)
      .border_color(t.colors.border)
      .child(div().text_size(t.type.title).font_semibold().child(this.target?.name ?? "No project"))
      .child(this.stepper(t, current))
      .child(div().flex_1())
      .children(this.actions(t));
  }

  stepper(t, current) {
    const steps = [];
    STEPS.forEach((label, index) => {
      if (index > 0) steps.push(div().w(22).h(1).bg(t.colors.input));
      const done = current >= 0 && index < current;
      const isCurrent = index === current;
      const row = h_flex()
        .id(`bdc-step-${index}`)
        .gap(6)
        .items_center()
        .when(done, (element) => element.cursor_pointer().on_click((_event, cx) => this.openStep(index, cx)))
        .child(
          h_flex()
            .w(17)
            .h(17)
            .items_center()
            .justify_center()
            .rounded(9)
            .border(1)
            .border_color(isCurrent ? t.colors.accent : done ? t.colors.pass : t.colors.input)
            .bg(isCurrent ? t.colors.selection : t.colors.canvas)
            .child(div().text_size(10).text_color(isCurrent ? t.colors.accent : done ? t.colors.pass : t.colors.dim).child(done ? "✓" : String(index + 1))),
        )
        .child(div().text_size(t.type.small).text_color(isCurrent ? t.colors.fg : done ? t.colors.muted : t.colors.dim).child(label));
      if (isCurrent && this.view !== null && this.view.needsYou) row.child(t.pill("needs you", "working"));
      steps.push(row);
    });
    return h_flex().gap(8).items_center().children(steps);
  }

  actions(t) {
    const view = this.view;
    if (view === null) return [];
    const running = !["done", "failed", "cancelled"].includes(view.stage);
    const actions = [];
    if (this.confirmingCancel) {
      actions.push(div().text_size(t.type.small).text_color(t.colors.muted).child("Cancel this run?"));
      actions.push(t.button("Yes, cancel", { id: "bdc-cancel-yes", danger: true }).on_click((_event, cx) => this.cancel(cx)));
      actions.push(t.button("Keep going", { id: "bdc-cancel-no" }).on_click((_event, cx) => this.stopConfirming(cx)));
      return actions;
    }
    if (running) {
      actions.push(
        view.paused
          ? t.button("Resume", { id: "bdc-resume" }).on_click((_event, cx) => this.send({ type: "RESUME" }, cx))
          : t.button("Pause", { id: "bdc-pause" }).on_click((_event, cx) => this.send({ type: "PAUSE" }, cx)),
      );
      actions.push(t.button("Cancel", { id: "bdc-cancel", danger: true }).on_click((_event, cx) => this.confirmCancel(cx)));
    }
    actions.push(t.button("Reviews", { id: "bdc-reviews" }).on_click((_event, cx) => this.go("reviews", {}, cx)));
    return actions;
  }

  confirmCancel(cx) {
    this.confirmingCancel = true;
    cx.notify();
  }

  stopConfirming(cx) {
    this.confirmingCancel = false;
    cx.notify();
  }

  cancel(cx) {
    this.confirmingCancel = false;
    void this.send({ type: "CANCEL" }, cx);
  }

  /** "The run moved on" — a banner with the way back, instead of pulling the screen away. */
  banner(t) {
    const view = this.view;
    if (view === null) return null;
    const wanted = stageScreen(view);
    if (this.open.screen === wanted && !this.open.readOnly) return null;
    const label = STEPS[stepOf(view.stage)] ?? view.stageWords;
    return h_flex()
      .id("bdc-banner")
      .flex_none()
      .h(32)
      .px(14)
      .gap(10)
      .items_center()
      .bg(t.colors.popover)
      .child(div().text_size(t.type.small).text_color(t.colors.muted).child(`The run is in ${view.stageWords}.`))
      .child(
        t.button(`Go to ${label}`, { id: "bdc-go-stage" }).on_click((_event, cx) => {
          this.follow = true;
          this.open = { screen: wanted, readOnly: false };
          cx.notify();
        }),
      );
  }

  screen(t) {
    if (this.target === null) return this.renderScreen("setup", t);
    if (this.target.runId === null) return this.renderScreen("goal", t);
    if (this.view === null) {
      return v_flex().flex_1().min_h(0).p(16).child(t.label("Reading the run…", { color: t.colors.dim }));
    }
    return this.renderScreen(this.open.screen, t);
  }

  renderScreen(name, t) {
    const module = SCREENS[name] ?? SCREENS.intake;
    const content = module.render(this.view, this.screenCtx(name, t));
    return v_flex().flex_1().min_h(0).p(14).child(content).when(this.error !== "", (column) => column.child(div().pt(8).text_size(t.type.small).text_color(t.colors.blocked).child(this.error)));
  }

  screenCtx(name, t) {
    const target = this.target;
    return {
      t,
      root: target?.root ?? null,
      target,
      view: this.view,
      send: (event) => (target === null ? Promise.resolve({ ok: false, error: "no project" }) : this.bdc.send(target.root, event, target.runId)),
      start: (goalText) => (target === null ? Promise.resolve({ ok: false, runId: null, error: "no project" }) : this.bdc.start(target.root, goalText)),
      cx: undefined,
      state: this.state[name] ?? {},
      setState: (patch, handlerCx) => {
        this.state[name] = { ...this.state[name], ...patch };
        if (handlerCx) handlerCx.notify();
      },
      input: (inputName, handlerCx) => this.input(inputName, handlerCx),
      inputs: this.inputs,
      readOnly: this.open.readOnly,
      go: (screen, patch, handlerCx) => this.go(screen, patch, handlerCx),
    };
  }
}
