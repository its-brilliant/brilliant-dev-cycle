// The design language of the bdc UI (docs/design/source/style.css) as GPUI elements.
//
// `look(theme())` reads the person's Herdr theme where it names the same color and falls back to
// the design's own value where it does not (the design was drawn on graphite), so the UI follows
// light and dark themes instead of pinning one. Everything a screen draws comes from here: pills,
// cards, buttons, section labels, and the tones that mean "waiting on you", "passed", "blocked".
import { div } from 'gpui-kit';
import { Popup, h_flex, v_flex } from 'gpui-base';

/** The design's own values, used where the theme has no name for the color. */
const DESIGN = {
  bg: '#17191d',
  canvas: '#131518',
  chrome: '#0f1114',
  popover: '#25272b',
  raised: '#2c2e31',
  border: '#2b2d31',
  input: '#3a3c40',
  fg: '#eeeeef',
  muted: '#98999b',
  dim: '#696a6d',
  accent: '#96b2d7',
  working: '#e5c07b',
  blocked: '#f0705f',
  done: '#76a8ff',
  pass: '#a6bd91',
  review: '#8cbdc3',
};

const RADII = { card: 10, panel: 8, button: 7, input: 8, pill: 5, chip: 6 };
const TYPE = { title: 13.5, ui: 12.5, small: 11.5, tiny: 10.5 };
const SPACE = { gap: 8, pad: 12, row: 26 };
const MONO = 'Geist Mono';

/** A theme color, or the design's value when the theme does not name it. */
function pick(colors, name, fallback) {
  const value = colors?.[name];
  return typeof value === 'string' && value.startsWith('#') ? value : fallback;
}

/** `#rrggbb` with an alpha byte, for the soft tints the design uses behind pills and cards. */
function tint(hex, alpha) {
  if (typeof hex !== 'string' || !hex.startsWith('#') || hex.length !== 7) return hex;
  return `${hex}${alpha}`;
}

/** The color a tone means: what is working, what needs the person, what passed. */
function toneColor(colors, tone) {
  switch (tone) {
    case 'working':
    case 'queued':
      return colors.working;
    case 'blocked':
      return colors.blocked;
    case 'done':
      return colors.done;
    case 'pass':
      return colors.pass;
    case 'review':
      return colors.review;
    case 'accent':
      return colors.accent;
    default:
      return colors.dim;
  }
}

/**
 * The look: `{ colors, radii, type, space, mono, pill, card, button, section, label, muted }`.
 * Builders return elements; call them inside `render`.
 */
export function look(themeColors) {
  const colors = {
    bg: pick(themeColors, 'background', DESIGN.bg),
    canvas: pick(themeColors, 'canvas', DESIGN.canvas),
    chrome: pick(themeColors, 'chrome', DESIGN.chrome),
    popover: pick(themeColors, 'popover', DESIGN.popover),
    raised: pick(themeColors, 'raised', DESIGN.raised),
    border: pick(themeColors, 'border', DESIGN.border),
    input: pick(themeColors, 'input', DESIGN.input),
    fg: pick(themeColors, 'foreground', DESIGN.fg),
    muted: pick(themeColors, 'muted', DESIGN.muted),
    dim: pick(themeColors, 'dim', DESIGN.dim),
    accent: pick(themeColors, 'accent', DESIGN.accent),
    accentFg: pick(themeColors, 'accent_foreground', DESIGN.chrome),
    solid: pick(themeColors, 'solid', DESIGN.fg),
    solidFg: pick(themeColors, 'solid_foreground', DESIGN.canvas),
    selection: pick(themeColors, 'selection', DESIGN.raised),
    working: pick(themeColors, 'working', DESIGN.working),
    blocked: pick(themeColors, 'blocked', DESIGN.blocked),
    done: pick(themeColors, 'done', DESIGN.done),
    pass: DESIGN.pass,
    review: DESIGN.review,
  };

  /** A status pill: a dot and a word, colored by what the word means. */
  function pill(text, tone = 'dim') {
    const color = toneColor(colors, tone);
    return h_flex()
      .h(19)
      .px(7)
      .gap(5)
      .rounded(RADII.pill)
      .border(1)
      .border_color(tint(color, '40'))
      .bg(tint(color, '14'))
      .items_center()
      .child(div().w(6).h(6).rounded(3).bg(color))
      .child(div().text_size(TYPE.tiny).text_color(color).whitespace_nowrap().child(text));
  }

  /** A card: the surface the design puts findings, phases and questions on. */
  function card(...children) {
    return v_flex().gap(SPACE.gap).p(SPACE.pad).rounded(RADII.card).border(1).border_color(colors.border).bg(colors.bg).children(children);
  }

  /**
   * A button. A disabled one says why (§9.1 rule 3): `reason` is its tooltip and its line under
   * the label, so the person knows what would enable it.
   */
  function button(label, options = {}) {
    const { id = '', primary = false, danger = false, disabled = false, reason = '' } = options;
    const base = primary ? colors.solid : colors.raised;
    const text = primary ? colors.solidFg : danger ? colors.blocked : colors.fg;
    const border = primary ? colors.solid : danger ? tint(colors.blocked, '59') : colors.input;
    const element = h_flex()
      .when(id !== '', (row) => row.id(id))
      .h(28)
      .px(11)
      .gap(6)
      .items_center()
      .rounded(RADII.button)
      .border(1)
      .border_color(border)
      .bg(disabled ? colors.raised : base)
      .text_size(TYPE.ui)
      .text_color(disabled ? colors.dim : text)
      .whitespace_nowrap()
      .child(div().child(label));
    if (disabled) {
      return element.disabled(true).tooltip(reason === '' ? 'Not available yet' : reason);
    }
    return element.cursor_pointer().hover((style) => style.opacity(0.88));
  }

  /** The small uppercase label the design puts above a group of rows. */
  function section(text) {
    return div().text_size(TYPE.tiny).text_color(colors.dim).child(text.toUpperCase());
  }

  /** Body text in the look's own size. */
  function label(text, options = {}) {
    const { size = TYPE.ui, color = colors.muted, wrap = true } = options;
    const element = div().text_size(size).text_color(color).child(text);
    return wrap ? element : element.whitespace_nowrap().truncate();
  }

  /**
   * A dropdown: the chosen value on a trigger, the options in a list under it. The screen owns
   * whether it is open (its own state), so a pick closes it and the trigger toggles it.
   * `options` are `{ key, label, hint? }`; `note` is one quiet line under the list (e.g. why some
   * choices are not offered), instead of a wall of disabled choices.
   */
  function dropdown(id, options) {
    const { value = '', choices = [], open = false, onToggle, onPick, placeholder = 'Choose…', note = '', width = 220 } = options;
    const chosen = choices.find((choice) => choice.key === value);
    const trigger = h_flex()
      .id(`${id}-trigger`)
      .w(width)
      .h(28)
      .px(10)
      .gap(6)
      .items_center()
      .rounded(RADII.input)
      .border(1)
      .border_color(open ? colors.accent : colors.input)
      .bg(colors.bg)
      .cursor_pointer()
      .hover((style) => style.bg(colors.raised))
      .on_click((_event, cx) => onToggle?.(!open, cx))
      .child(div().flex_1().min_w(0).truncate().text_size(TYPE.ui).text_color(chosen === undefined ? colors.dim : colors.fg).child(chosen?.label ?? placeholder))
      .child(div().text_size(TYPE.tiny).text_color(colors.dim).child(open ? '▴' : '▾'));
    const list = v_flex()
      .w(width)
      .mt(4)
      .p(4)
      .gap(2)
      .rounded(RADII.input)
      .border(1)
      .border_color(colors.border)
      .bg(colors.popover)
      .shadow_md()
      .children(
        choices.map((choice) =>
          v_flex()
            .id(`${id}-option-${choice.key}`)
            .px(8)
            .py(5)
            .rounded(RADII.chip)
            .bg(choice.key === value ? colors.selection : colors.popover)
            .cursor_pointer()
            .hover((style) => style.bg(colors.raised))
            .on_click((_event, cx) => onPick?.(choice.key, cx))
            .child(div().text_size(TYPE.ui).text_color(colors.fg).child(choice.label))
            .when(typeof choice.hint === 'string' && choice.hint !== '', (row) => row.child(div().text_size(TYPE.tiny).text_color(colors.dim).child(choice.hint))),
        ),
      )
      .when(note !== '', (column) => column.child(div().px(8).pt(4).text_size(TYPE.tiny).text_color(colors.dim).child(note)));
    return Popup.new(id, trigger).anchor('bottom_left').when(open, (popup) => popup.content(list));
  }

  return { colors, radii: RADII, type: TYPE, space: SPACE, mono: MONO, pill, card, button, section, label, dropdown };
}
