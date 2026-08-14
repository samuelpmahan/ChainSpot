/**
 * Cross-component request/callback indirection letting the shared app header
 * (`+layout.svelte`, which has no access to whichever annotation route is
 * currently mounted) drive that route's "Done" control.
 *
 * Before the Annotate Round UX split this also carried a Map/Round mode
 * field so the header could render a mode toggle over a single shared route.
 * Mode is now fixed per route (`/annotate-course` vs `/map-round`), so there
 * is nothing left to toggle — only the finish/done affordance is shared.
 */

interface AnnotationNavRegistration {
	token: number;
	onDone: () => void;
}

export const annotationNavState = $state({
	active: false,
	canFinish: false,
	doneRunning: false
});

let nextToken = 0;
let activeRegistration: AnnotationNavRegistration | null = null;

export function registerAnnotationNav(config: {
	canFinish: boolean;
	doneRunning: boolean;
	onDone: () => void;
}): number {
	const token = ++nextToken;
	activeRegistration = {
		token,
		onDone: config.onDone
	};
	annotationNavState.active = true;
	annotationNavState.canFinish = config.canFinish;
	annotationNavState.doneRunning = config.doneRunning;
	return token;
}

export function updateAnnotationNav(
	token: number,
	state: { canFinish: boolean; doneRunning: boolean }
): void {
	if (activeRegistration?.token !== token) return;
	annotationNavState.canFinish = state.canFinish;
	annotationNavState.doneRunning = state.doneRunning;
}

export function unregisterAnnotationNav(token: number): void {
	if (activeRegistration?.token !== token) return;
	activeRegistration = null;
	annotationNavState.active = false;
	annotationNavState.canFinish = false;
	annotationNavState.doneRunning = false;
}

export function requestAnnotationDone(): void {
	if (!annotationNavState.canFinish || annotationNavState.doneRunning) return;
	activeRegistration?.onDone();
}
