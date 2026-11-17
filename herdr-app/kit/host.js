// The `herdr` functions the kit needs, gathered in one module.
//
// Every other kit module is plain JavaScript that imports nothing from Herdr, so a test can
// import it (see tests/herdr/kit.test.ts) and so the same code is checkable with `herdr-app
// check` without a live window. A mod builds `host` once in `init` and hands it to the kit.
import {
  appHome,
  checking,
  closeOverlay,
  exec,
  home,
  notify,
  openOverlay,
  readTextFile,
  setShared,
  shared,
  spaces,
  theme,
  watchFolder,
} from "herdr";

export const host = {
  appHome,
  checking,
  closeOverlay,
  exec,
  home,
  notify,
  openOverlay,
  readTextFile,
  setShared,
  shared,
  spaces,
  theme,
  watchFolder,
};
