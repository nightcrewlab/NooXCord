import { useSyncExternalStore } from "react";

/*
 * Screen shapes the layout reacts to (CLAUDE.md §9.1). The style sheets use the same queries.
 *
 * Mobile: narrow (< 768 px), or short. A phone held sideways is 800+ px wide but under 450 px tall and
 * used to get the four-column desktop layout squeezed into that height.
 * Phone landscape: short and wide. The minimum width keeps an upright phone whose on-screen keyboard
 * shrank the viewport from flipping into the landscape layout while typing.
 * 500 px is under the desktop window's smallest content height (minHeight 560 with its title bar), so
 * the desktop app never lands in the phone layout.
 */
const MQ_MOBILE = "(max-width: 767px), (max-height: 500px)";
const MQ_PHONE_LANDSCAPE = "(orientation: landscape) and (max-height: 500px) and (min-width: 560px)";

function useMq(query: string): boolean {
  return useSyncExternalStore(
    (cb) => {
      const m = window.matchMedia(query);
      m.addEventListener("change", cb);
      return () => m.removeEventListener("change", cb);
    },
    () => window.matchMedia(query).matches,
  );
}

export const useMobile = (): boolean => useMq(MQ_MOBILE);
/** A phone held sideways: tabs on the side, call controls in a column, everything a little smaller. */
export const usePhoneLandscape = (): boolean => useMq(MQ_PHONE_LANDSCAPE);
