# bdc dev-cycle layout: design reference (source of truth)

These HTML files are the exact source that the Figma frames in
https://www.figma.com/design/x0p11F0EUz4rJc1qF0siqa were rendered from.
Open any file in a browser to see the frame pixel for pixel.

- `style.css` holds every design token and component class. Port its `:root` variables and classes as they are; don't re-derive them.
- 01-spec, 02-phase-dag, 03-progress, 04-phase-detail, 05-verify, 06-reviewers, 07-ship, 08-settings
- Each artboard wraps the app in `.artboard`/`.caption`/`.window`. Drop that wrapper; everything inside `.window` is the app.
- Fonts: Geist (UI), Geist Mono (ids, paths, counts). Base size 12.5px.
- Status colours: working #e5c07b, blocked #f0705f (blocked only), done #76a8ff, pass #a6bd91, review #8cbdc3, accent #96b2d7.
- Agent icons: *.inline.svg. Herdr mark: herdr.png.
