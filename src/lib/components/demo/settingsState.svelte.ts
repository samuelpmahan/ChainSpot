/**
 * Shared open/closed state for the Demo Settings popover.
 *
 * Module-level rather than component-local for one reason: choosing a new
 * guide style swaps the entire presentation component, unmounting the
 * `DemoSettings` instance embedded in it. If the popover's `open` flag lived
 * in that instance, every style choice would slam the popover shut — the
 * exact moment a visitor is comparing styles back-to-back. Keeping the flag
 * here lets the popover survive the swap and reappear on the new
 * presentation's own settings affordance.
 *
 * Ephemeral by design: not persisted anywhere, reset on reload.
 */
export const demoSettingsUi = $state({ open: false });
