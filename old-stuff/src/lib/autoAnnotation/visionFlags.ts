/**
 * Console-only controls for the experimental course-vision candidate.
 *
 * These are deliberately runtime flags rather than product settings: they
 * make a prestaging comparison reproducible without adding UI. The worker
 * never reads storage; callers take a frozen snapshot and send that snapshot
 * with each request.
 */

export const VISION_FLAGS_STORAGE_KEY = 'chainspot.vision.flags';

export type ZeroBendMaxDistancePx = 3 | 4;
export type P1Profile = 'tuned' | 'historical';

export interface VisionFlags {
	readonly zeroBendShortcutEnabled: boolean;
	readonly zeroBendMaxDistancePx: ZeroBendMaxDistancePx;
	readonly p1Profile: P1Profile;
}

export const DEFAULT_VISION_FLAGS: VisionFlags = Object.freeze({
	zeroBendShortcutEnabled: true,
	zeroBendMaxDistancePx: 3,
	p1Profile: 'tuned'
});

export type VisionFlagKey = keyof VisionFlags;
export type VisionFlagValue = VisionFlags[VisionFlagKey];

const FLAG_HELP = Object.freeze({
	list: 'chainspot.flags.list() -> current persisted flags',
	set: "chainspot.flags.set('zeroBendShortcutEnabled', false) or chainspot.flags.set('zeroBendMaxDistancePx', 4)",
	p1: "chainspot.flags.set('p1Profile', 'historical') or chainspot.flags.set('p1Profile', 'tuned')",
	reset: 'chainspot.flags.reset() -> restore candidate defaults',
	help: 'chainspot.flags.help() -> show this help'
});

function isStorageAvailable(): boolean {
	return typeof localStorage !== 'undefined';
}

function readPersisted(): Partial<VisionFlags> {
	if (!isStorageAvailable()) return {};
	try {
		const raw = localStorage.getItem(VISION_FLAGS_STORAGE_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object') return {};
		const value = parsed as Record<string, unknown>;
		return {
			...(typeof value.zeroBendShortcutEnabled === 'boolean'
				? { zeroBendShortcutEnabled: value.zeroBendShortcutEnabled }
				: {}),
			...(value.zeroBendMaxDistancePx === 3 || value.zeroBendMaxDistancePx === 4
				? { zeroBendMaxDistancePx: value.zeroBendMaxDistancePx }
				: {}),
			...(value.p1Profile === 'tuned' || value.p1Profile === 'historical'
				? { p1Profile: value.p1Profile }
				: {})
		};
	} catch {
		return {};
	}
}

function persist(flags: VisionFlags): void {
	if (!isStorageAvailable()) return;
	try {
		localStorage.setItem(VISION_FLAGS_STORAGE_KEY, JSON.stringify(flags));
	} catch {
		// Dev-console controls must never break course detection when storage is blocked.
	}
}

function snapshot(flags: VisionFlags): VisionFlags {
	return Object.freeze({ ...flags });
}

let currentFlags = snapshot({ ...DEFAULT_VISION_FLAGS, ...readPersisted() });

export function getVisionFlagsSnapshot(): VisionFlags {
	return snapshot(currentFlags);
}

export function setVisionFlag<K extends VisionFlagKey>(key: K, value: VisionFlags[K]): VisionFlags {
	if (key === 'zeroBendShortcutEnabled' && typeof value !== 'boolean') {
		throw new TypeError(`${key} must be true or false`);
	}
	if (key === 'zeroBendMaxDistancePx' && value !== 3 && value !== 4) {
		throw new TypeError(`${key} must be 3 or 4`);
	}
	if (key === 'p1Profile' && value !== 'tuned' && value !== 'historical') {
		throw new TypeError(`${key} must be tuned or historical`);
	}
	currentFlags = snapshot({ ...currentFlags, [key]: value });
	persist(currentFlags);
	return getVisionFlagsSnapshot();
}

export function resetVisionFlags(): VisionFlags {
	currentFlags = snapshot(DEFAULT_VISION_FLAGS);
	if (isStorageAvailable()) {
		try {
			localStorage.removeItem(VISION_FLAGS_STORAGE_KEY);
		} catch {
			// See persist().
		}
	}
	return getVisionFlagsSnapshot();
}

export function visionFlagHelp(): Readonly<typeof FLAG_HELP> {
	return FLAG_HELP;
}

export interface ChainSpotVisionFlagsConsole {
	readonly list: () => VisionFlags;
	readonly set: <K extends VisionFlagKey>(key: K, value: VisionFlags[K]) => VisionFlags;
	readonly reset: () => VisionFlags;
	readonly help: () => Readonly<typeof FLAG_HELP>;
}

declare global {
	// eslint-disable-next-line no-var
	var chainspot: {
		readonly flags: ChainSpotVisionFlagsConsole;
	} | undefined;
}

/** Install the `chainspot.flags.*` console API once in a browser runtime. */
export function installVisionFlagConsole(): void {
	if (typeof window === 'undefined' || globalThis.chainspot?.flags) return;
	const api: ChainSpotVisionFlagsConsole = Object.freeze({
		list: getVisionFlagsSnapshot,
		set: setVisionFlag,
		reset: resetVisionFlags,
		help: visionFlagHelp
	});
	globalThis.chainspot = Object.freeze({ flags: api });
	document.documentElement.dataset.chainspotFlagsReady = 'true';
}
