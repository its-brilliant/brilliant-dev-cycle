// PM chat (spec §9.4, §3.4): the run's transcript, the question card, agent prompts and the
// composer. It only reads the run's view and sends person events through `bdc` (§7.2), so
// everything it shows is what the daemon projected and everything it does is one event.
//
// The question card is the CLI's question tool, copied in as `./kit/question-tool.js` (it is pure
// JavaScript with no imports): `startAsk` → `press` → `result` drive the answers one at a time,
// and this mod draws the card in GPUI instead of the tool's text lines.
import { View, div } from "gpui-kit";
import { Input, InputState, ScrollHandle, h_flex, v_flex } from "gpui-base";
import { BDC } from "./kit/bdc-command.js";
import { bdcCommands } from "./kit/bdc.js";
import { host } from "./kit/host.js";
import { look } from "./kit/look.js";
import { resolveProject, sameTarget } from "./kit/project.js";
import { BACK, BACKSPACE, ENTER, ESC, OTHER, SKIP, optionsOf, press, result, startAsk } from "./kit/question-tool.js";
import { watchRun } from "./kit/view.js";
import { authorLabel, plural } from "./kit/words.js";

/** The key a GPUI keyboard event means to the question tool (spec §3.4: 1–9, Enter, b, s, o). */
function keyOf(event) {
  if (event.key === "enter") return ENTER;
  if (event.key === "backspace") return BACKSPACE;
  if (event.key === "escape") return ESC;
  const typed = typeof event.key_char === "string" && event.key_char.length === 1 ? event.key_char : event.key;
  return typeof typed === "string" && typed.length === 1 ? typed : null;
}

/** One agent prompt's identity: the same words from the same agent later are a new question. */
function promptKey(prompt) {
  return `${prompt.agentKey}\u0000${prompt.prompt}`;
}

/** The keys that do something on the card now, in the question tool's own words (§9.1 rule 3). */
function cardHint(question, state) {
  if (state.typing) return "Type your answer, Enter to keep it, Esc to go back to the choices";
  if (question.kind === "multi") return "1–9 to choose, Enter when you are done";
  if (question.kind === "text") return "Enter to type your answer";
  const parts = ["1–9 to pick"];
  if (question.kind === "confirm" || question.recommended !== undefined) parts.push("Enter for the recommended");
  if (question.allowOther) parts.push("o to type your own answer");
  return parts.join(", ");
}

export default class BdcPm extends View {
  init(_props, cx) {
    this.bdc = bdcCommands(host, BDC);
    /** `{ root, machine, space, name, runId }` or null (no bdc.yaml in the active space). */
    this.target = null;
    this.view = null;
    this.watcher = null;
    /** The question card's live state: `{ askId, state }` (an AskState from the question tool). */
    this.ask = null;
    this.answeredAsks = new Set();
    this.prompted = new Set();
    /** What a send is doing, in words, while it is in flight. */
    this.sending = null;
    this.error = "";
    this.follow = true;
    this.chat = ScrollHandle.new();
    this.input = InputState.new({ placeholder: "Message the PM" });
    this.input.on("submit", (_event, inputCx) => this.sendMessage(inputCx));
    this.handle = cx.focus_handle();
    // A check loads the mod for real: no timers, no `bdc`, no folder watches.
    if (host.checking()) return;
    cx.timer.every(3000, (timerCx) => this.sync(timerCx));
    this.sync(cx);
  }

  /** The project or run the UI shows can change under it (another space, a new run). */
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
    this.ask = null;
    this.answeredAsks = new Set();
    this.prompted = new Set();
    if (next !== null && next.runId !== null) this.watcher = watchRun(host, cx, next, (view) => this.onView(view));
    cx.notify();
  }

  onView(view) {
    const previous = this.view;
    this.view = view;
    if (this.follow && view.chat.length !== (previous?.chat.length ?? 0)) {
      this.chat.scroll_to_item(Math.max(0, view.chat.length - 1));
    }
    this.syncAsk(view);
    this.forgetClearedPrompts(view.agentPrompts);
  }

  /** A new ask opens the card on its first question; an ask that left the view closes it. */
  syncAsk(view) {
    const ask = view.asking;
    if (ask === null) {
      this.ask = null;
      return;
    }
    if (this.ask !== null && this.ask.askId === ask.askId) return;
    if (this.answeredAsks.has(ask.askId)) {
      this.ask = null;
      return;
    }
    this.ask = { askId: ask.askId, state: startAsk(ask.questions) };
    // The card owns the keys the moment it appears, so 1–9 and Enter work without a click.
    this.handle.focus();
  }

  /** A prompt that left the view was answered; the same words later are a new question. */
  forgetClearedPrompts(prompts) {
    const showing = new Set(prompts.map(promptKey));
    for (const key of this.prompted) if (!showing.has(key)) this.prompted.delete(key);
  }

  /** One person event through `bdc send`; the failure is shown inline, not thrown. */
  send(event, words, cx) {
    const target = this.target;
    if (target === null) return;
    this.sending = words;
    this.error = "";
    cx.notify();
    cx.spawn(async (asyncCx) => {
      const outcome = await this.bdc.send(target.root, event, target.runId);
      this.sending = null;
      if (!outcome.ok) this.error = outcome.error;
      asyncCx.notify();
    });
  }

  sendMessage(cx) {
    const text = this.input.value().trim();
    if (text === "" || this.target === null || this.target.runId === null) return;
    this.input.set_value("");
    this.send({ type: "MESSAGE", text }, "Sending your message…", cx);
  }

  /** One key to the question tool, and whatever its answer becomes (spec §3.4). */
  pressCard(key, cx) {
    if (this.ask === null || key === null) return;
    const next = press(this.ask.state, key);
    if (next !== this.ask.state) this.ask = { askId: this.ask.askId, state: next };
    // The card keeps the keys: a click on an option or on Other… must not leave them in the box.
    this.handle.focus();
    if (next.sent) this.sendAnswers(cx);
    cx.notify();
  }

  sendAnswers(cx) {
    const ask = this.view?.asking ?? null;
    const card = this.ask;
    if (ask === null || card === null) return;
    const answered = result(card.state);
    if (answered === null) return;
    this.answeredAsks.add(ask.askId);
    this.ask = null;
    // An intake round answers the PM's turn; a scoped ask answers the phase or agent that asked.
    const event = ask.scope === null ? { type: "ROUND_ANSWERED", answers: answered.answers } : { type: "ANSWER", askId: ask.askId, answers: answered.answers };
    this.send(event, "Sending your answers…", cx);
  }

  choose(prompt, choice, cx) {
    this.prompted.add(promptKey(prompt));
    this.send({ type: "PROMPT_CHOICE", agentKey: prompt.agentKey, choice }, "Sending your choice…", cx);
  }

  async close(_cx) {
    this.watcher?.stop();
    this.watcher = null;
  }

  // ── render ────────────────────────────────────────────────────────────────────────────────

  render() {
    const t = look(host.theme());
    return v_flex().size_full().min_h(0).bg(t.colors.bg).text_color(t.colors.fg).child(this.header(t)).child(this.body(t));
  }

  /** "PM" and what it is doing, in words (§9.4). */
  header(t) {
    const view = this.view;
    const words = view === null ? "not connected" : view.asking !== null ? "waiting on you" : view.stageWords;
    const tone = view !== null && view.asking !== null ? "working" : "accent";
    return h_flex()
      .id("pm-header")
      .flex_none()
      .h(34)
      .px(12)
      .gap(8)
      .items_center()
      .border_b(1)
      .border_color(t.colors.border)
      .child(div().text_size(t.type.title).font_semibold().child("PM"))
      // No run, no status: the body already says what to do first.
      .when(view !== null, (row) => row.child(t.pill(words, tone)));
  }

  body(t) {
    if (this.target === null) {
      return this.empty(t, "Pick a project", "The PM chat follows the project of the space you are in.");
    }
    if (!this.target.configured) {
      return this.empty(t, "Set up bdc for this folder", "Choose the agents in the main area first; then the PM talks to you here.");
    }
    if (this.target.runId === null) {
      return this.empty(t, "Start a run from the main area", "Type a goal there and press Start; the PM will talk to you here.");
    }
    if (this.view === null) return this.empty(t, "Reading the run…", "The PM chat fills in as soon as the run writes its view.");
    return v_flex().flex_1().min_h(0).children([this.transcript(t), this.cards(t), this.composer(t)]);
  }

  empty(t, title, detail) {
    return v_flex().flex_1().min_h(0).p(18).gap(8).child(div().text_size(t.type.title).text_color(t.colors.fg).child(title)).child(t.label(detail, { color: t.colors.muted }));
  }

  transcript(t) {
    const chat = this.view?.chat ?? [];
    const lines =
      chat.length === 0
        ? [div().pt(8).text_size(t.type.small).text_color(t.colors.dim).child("Nothing said yet. Ask the PM anything, or answer its questions above the box.")]
        : chat.map((entry, index) => this.message(t, entry, index));
    return v_flex()
      .id("pm-transcript")
      .flex_1()
      .min_h(0)
      .gap(10)
      .p(12)
      .overflow_y_scrollbar()
      .track_scroll(this.chat)
      .on_scroll_wheel((_event, cx) => {
        // The person is reading history: stop dragging them back to the newest line.
        if (!this.follow) return;
        this.follow = false;
        cx.notify();
      })
      .children(lines);
  }

  message(t, entry, index) {
    const mine = entry.from === "you";
    return h_flex()
      .id(`pm-message-${index}`)
      .gap(9)
      .items_start()
      .child(
        h_flex()
          .flex_none()
          .w(26)
          .h(22)
          .items_center()
          .justify_center()
          .rounded(6)
          .bg(mine ? t.colors.accent : t.colors.raised)
          .child(div().text_size(9.5).text_color(mine ? t.colors.accentFg : t.colors.muted).child(mine ? "You" : "PM")),
      )
      .child(
        v_flex()
          .flex_1()
          .min_h(0)
          .gap(3)
          .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(authorLabel(entry.from)))
          .child(div().text_size(t.type.ui).text_color(t.colors.muted).child(entry.text)),
      );
  }

  /** The question card, the agent prompts, the send line and the failure — above the composer. */
  cards(t) {
    const children = [];
    if (this.ask !== null && this.view?.asking !== null) children.push(this.questionCard(t));
    for (const prompt of this.view?.agentPrompts ?? []) {
      if (!this.prompted.has(promptKey(prompt))) children.push(this.promptCard(t, prompt));
    }
    if (this.sending !== null) children.push(div().text_size(t.type.small).text_color(t.colors.dim).child(this.sending));
    if (this.error !== "") children.push(div().id("pm-error").text_size(t.type.small).text_color(t.colors.blocked).child(this.error));
    if (!this.follow) {
      children.push(
        h_flex()
          .id("pm-newest")
          .gap(6)
          .items_center()
          .cursor_pointer()
          .on_click((_event, cx) => {
            this.follow = true;
            this.chat.scroll_to_item(Math.max(0, (this.view?.chat.length ?? 1) - 1));
            cx.notify();
          })
          .child(div().text_size(t.type.small).text_color(t.colors.accent).child("Jump to the newest message")),
      );
    }
    if (children.length === 0) return div();
    return v_flex().flex_none().gap(8).px(12).pb(10).children(children);
  }

  /**
   * The question card (§3.4, §9.4): one question at a time, options as buttons with the
   * recommended one marked, Other…, Back, Skip, "2 of 4", keys 1–9 and Enter; after the last
   * question a one-line summary and Send.
   */
  questionCard(t) {
    const state = this.ask.state;
    const finished = state.screen >= state.questions.length;
    const question = finished ? null : state.questions[state.screen];
    const header = h_flex()
      .id("pm-question-header")
      .items_center()
      .gap(7)
      .child(div().text_size(t.type.small).text_color(t.colors.muted).child(finished ? "Here are your answers" : "Question"))
      .child(div().flex_1())
      .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(finished ? "Review" : `${state.screen + 1} of ${state.questions.length}`));

    const rows = finished ? state.questions.map((item, index) => this.summaryRow(t, item, state.answers[index] ?? null)) : this.questionRows(t, state, question);
    const footer = finished ? this.summaryFooter(t) : this.questionFooter(t, state, question);

    return v_flex()
      .id("pm-question")
      .flex_none()
      .gap(8)
      .p(10)
      .rounded(t.radii.card)
      .border(1)
      // Accent, not the error colour: a question for the person is not something that went wrong.
      .border_color(t.colors.accent)
      .bg(t.colors.popover)
      .track_focus(this.handle)
      .on_key_down((event, cx) => {
        const key = keyOf(event);
        if (key === null) return;
        this.pressCard(key, cx);
        cx.stop_propagation();
      })
      .child(header)
      .children(rows)
      .child(footer);
  }

  /** The question on screen: title, context, the options, and Other… when it is allowed. */
  questionRows(t, state, question) {
    const rows = [div().text_size(13).text_color(t.colors.fg).child(question.title)];
    if (question.body.trim() !== "") rows.push(div().text_size(t.type.ui).text_color(t.colors.muted).child(question.body));
    if (state.typing) {
      rows.push(div().text_size(t.type.ui).text_color(t.colors.fg).child(`Your answer: ${state.text}`));
      return rows;
    }
    const options = optionsOf(question);
    options.forEach((option, index) => rows.push(this.optionRow(t, state, question, option, index)));
    if (question.allowOther && question.kind !== "text") {
      rows.push(
        h_flex()
          .id("pm-other")
          .px(8)
          .py(6)
          .rounded(t.radii.chip)
          .border(1)
          .border_color(t.colors.border)
          .cursor_pointer()
          .hover((style) => style.bg(t.colors.raised))
          .on_click((_event, cx) => this.pressCard(OTHER, cx))
          .child(div().text_size(t.type.ui).text_color(t.colors.muted).child("Other…")),
      );
    }
    return rows;
  }

  optionRow(t, state, question, option, index) {
    const recommended = option.id === question.recommended;
    const picked = state.picked.includes(option.id);
    const multi = question.kind === "multi";
    const row = h_flex()
      .id(`pm-option-${option.id}`)
      .px(8)
      .py(6)
      .gap(8)
      .items_center()
      .rounded(t.radii.chip)
      .border(1)
      .border_color(recommended ? t.colors.accent : t.colors.border)
      .bg(t.colors.bg)
      .cursor_pointer()
      .hover((style) => style.bg(t.colors.raised))
      .on_click((_event, cx) => this.pressCard(String(index + 1), cx))
      .child(div().w(14).text_size(t.type.tiny).text_color(t.colors.dim).child(String(index + 1)));
    if (multi) row.child(div().text_size(t.type.tiny).text_color(t.colors.muted).child(picked ? "[x]" : "[ ]"));
    row.child(div().flex_1().text_size(t.type.ui).text_color(t.colors.fg).child(option.label));
    if (recommended) row.child(div().text_size(t.type.tiny).text_color(t.colors.accent).child("recommended"));
    const withHint =
      option.hint === undefined || option.hint.trim() === ""
        ? row
        : v_flex()
            .gap(2)
            .child(row)
            .child(div().pl(30).text_size(t.type.tiny).text_color(t.colors.dim).child(option.hint.trim()));
    return withHint;
  }

  questionFooter(t, state, question) {
    const row = h_flex().gap(8).items_center();
    // Back is only there when there is a question behind this one (§9.1 rule 3).
    if (state.screen > 0) row.child(t.button("Back", { id: "pm-back" }).on_click((_event, cx) => this.pressCard(BACK, cx)));
    row.child(t.button("Skip", { id: "pm-skip" }).on_click((_event, cx) => this.pressCard(SKIP, cx)));
    // The key hint gets its own line, so it wraps in a narrow chat instead of running off the edge.
    return v_flex()
      .gap(6)
      .child(row)
      .child(div().w_full().text_size(t.type.tiny).text_color(t.colors.dim).child(cardHint(question, state)));
  }

  summaryRow(t, question, answer) {
    return h_flex()
      .gap(6)
      .child(div().flex_1().text_size(t.type.ui).text_color(t.colors.muted).child(question.title))
      .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(answerWords(question, answer)));
  }

  summaryFooter(t) {
    return h_flex()
      .gap(8)
      .items_center()
      .child(t.button("Back", { id: "pm-summary-back" }).on_click((_event, cx) => this.pressCard(BACK, cx)))
      .child(div().flex_1())
      .child(t.button("Send", { id: "pm-summary-send", primary: true }).on_click((_event, cx) => this.pressCard(ENTER, cx)));
  }

  /** A trust or permission prompt from an agent (§3.4, §9.1 rule 6): its choices, no recommendation. */
  promptCard(t, prompt) {
    return v_flex()
      .id(`pm-prompt-${prompt.agentKey}`)
      .flex_none()
      .gap(8)
      .p(10)
      .rounded(t.radii.card)
      .border(1)
      .border_color(t.colors.working)
      .bg(t.colors.popover)
      .child(div().text_size(t.type.small).text_color(t.colors.muted).child("An agent is waiting on you"))
      .child(div().text_size(t.type.ui).text_color(t.colors.fg).child(prompt.prompt))
      .child(
        h_flex()
          .gap(6)
          .flex_wrap()
          .children(
            prompt.choices.map((choice, index) =>
              t.button(choice, { id: `pm-prompt-${prompt.agentKey}-${index}` }).on_click((_event, cx) => this.choose(prompt, choice, cx)),
            ),
          ),
      );
  }

  composer(t) {
    return v_flex()
      .flex_none()
      .gap(6)
      .p(10)
      .border_t(1)
      .border_color(t.colors.border)
      .child(Input.new(this.input).h(54).px(10).py(9).rounded(t.radii.input).border(1).border_color(t.colors.input).bg(t.colors.canvas).text_size(t.type.ui).text_color(t.colors.fg))
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().flex_1().text_size(t.type.tiny).text_color(t.colors.dim).child("Enter sends."))
          .child(div().text_size(t.type.tiny).text_color(t.colors.dim).child(plural((this.view?.chat ?? []).length, "message"))),
      );
  }
}

/** One answer in people words: the option labels, the typed text, or "skipped" (§9.1 rule 4). */
function answerWords(question, answer) {
  if (answer === null) return "not answered yet";
  if (answer.skipped) return "skipped";
  if (answer.text !== "") return answer.text;
  if (answer.picked.length === 0) return "none";
  return answer.picked.map((id) => optionsOf(question).find((option) => option.id === id)?.label ?? id).join(", ");
}
