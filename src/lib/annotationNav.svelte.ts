export type AnnotationNavMode = 'map' | 'round';

interface AnnotationNavRegistration {
	token: number;
	onModeChange: (mode: AnnotationNavMode) => void;
	onDone: () => void;
}

export const annotationNavState = $state({
	active: false,
	mode: 'map' as AnnotationNavMode,
	canFinish: false,
	doneRunning: false
});

let nextToken = 0;
let activeRegistration: AnnotationNavRegistration | null = null;

export function registerAnnotationNav(config: {
	mode: AnnotationNavMode;
	canFinish: boolean;
	doneRunning: boolean;
	onModeChange: (mode: AnnotationNavMode) => void;
	onDone: () => void;
}): number {
	const token = ++nextToken;
	activeRegistration = {
		token,
		onModeChange: config.onModeChange,
		onDone: config.onDone
	};
	annotationNavState.active = true;
	annotationNavState.mode = config.mode;
	annotationNavState.canFinish = config.canFinish;
	annotationNavState.doneRunning = config.doneRunning;
	return token;
}

export function updateAnnotationNav(
	token: number,
	state: { mode: AnnotationNavMode; canFinish: boolean; doneRunning: boolean }
): void {
	if (activeRegistration?.token !== token) return;
	annotationNavState.mode = state.mode;
	annotationNavState.canFinish = state.canFinish;
	annotationNavState.doneRunning = state.doneRunning;
}

export function unregisterAnnotationNav(token: number): void {
	if (activeRegistration?.token !== token) return;
	activeRegistration = null;
	annotationNavState.active = false;
	annotationNavState.mode = 'map';
	annotationNavState.canFinish = false;
	annotationNavState.doneRunning = false;
}

export function requestAnnotationMode(mode: AnnotationNavMode): void {
	activeRegistration?.onModeChange(mode);
}

export function requestAnnotationDone(): void {
	if (!annotationNavState.canFinish || annotationNavState.doneRunning) return;
	activeRegistration?.onDone();
}
