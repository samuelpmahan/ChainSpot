import type { LandmarkKind, LocalSnapTrace } from './landmarkTrace';

const CHANNEL_NAME = 'chainspot-cv-funnel-v1';
const MAX_OBSERVATIONS = 128;
const MAX_RECOMMENDATION_AGE_MS = 30 * 60 * 1000;
const MAX_RECOMMENDATION_EVIDENCE_DISTANCE_PX = 96;

export interface SurfacedCandidateObservation {
	readonly sequence: number;
	readonly observedAtMs: number;
	readonly kind: LandmarkKind;
	readonly candidateIndex?: number;
	readonly xPx: number;
	readonly yPx: number;
	readonly widthPx?: number;
	readonly heightPx?: number;
}

type FunnelMessage =
	| { readonly type: 'surfaced-candidate'; readonly observation: SurfacedCandidateObservation }
	| { readonly type: 'local-snap'; readonly trace: LocalSnapTrace };

const surfaced: SurfacedCandidateObservation[] = [];
const localSnaps: LocalSnapTrace[] = [];
let sequence = 0;
let channel: BroadcastChannel | null = null;
let channelInitialized = false;

function trim<T>(items: T[]): void {
	if (items.length > MAX_OBSERVATIONS) items.splice(0, items.length - MAX_OBSERVATIONS);
}

function receive(message: FunnelMessage): void {
	if (message.type === 'surfaced-candidate') {
		if (!surfaced.some((item) => item.sequence === message.observation.sequence && item.observedAtMs === message.observation.observedAtMs)) {
			surfaced.push(message.observation);
			trim(surfaced);
		}
		return;
	}
	localSnaps.push(message.trace);
	trim(localSnaps);
}

function runtimeChannel(): BroadcastChannel | null {
	if (channelInitialized) return channel;
	channelInitialized = true;
	if (typeof BroadcastChannel === 'undefined') return null;
	try {
		channel = new BroadcastChannel(CHANNEL_NAME);
		channel.onmessage = (event: MessageEvent<FunnelMessage>) => receive(event.data);
		// Node's BroadcastChannel can keep Vitest alive. Browsers simply do not
		// expose unref, so this remains a no-op there.
		(channel as BroadcastChannel & { unref?: () => void }).unref?.();
	} catch {
		channel = null;
	}
	return channel;
}

function publish(message: FunnelMessage): void {
	try {
		runtimeChannel()?.postMessage(message);
	} catch {
		// Observability must never make annotation fail.
	}
}

/**
 * Called only at the CV->domain acceptance boundary. The observation stays in
 * this diagnostics module; `AnnotatedHole` still receives only `{xPx,yPx}`.
 */
export function recordSurfacedCandidate(input: Omit<SurfacedCandidateObservation, 'sequence' | 'observedAtMs'>): SurfacedCandidateObservation {
	const observation: SurfacedCandidateObservation = {
		...input,
		sequence: ++sequence,
		observedAtMs: Date.now()
	};
	surfaced.push(observation);
	trim(surfaced);
	publish({ type: 'surfaced-candidate', observation });
	return observation;
}

function inferSnapKind(trace: LocalSnapTrace): LandmarkKind | undefined {
	if (trace.kind) return trace.kind;
	if (trace.calibrationSource?.includes('tee-')) return 'tee';
	if (trace.calibrationSource === 'number-badge-template-scale') return 'basket';
	if (trace.bestCandidateScore?.name.startsWith('tee.')) return 'tee';
	if (trace.bestCandidateScore?.name.startsWith('basket.')) return 'basket';
	return undefined;
}

/** Called by the detector worker after every local-snap attempt. */
export function recordLocalSnapTrace(trace: LocalSnapTrace): void {
	const kind = inferSnapKind(trace);
	const observed = kind && !trace.kind ? { ...trace, kind } : trace;
	localSnaps.push(observed);
	trim(localSnaps);
	publish({ type: 'local-snap', trace: observed });
}

/**
 * Full-course recommendation evidence available to a later local snap. This
 * never directly moves a marker; it can only provide measured footprint and
 * comparison distance to the local detector.
 */
export function nearestSurfacedRecommendation(
	kind: LandmarkKind,
	clickPx: { readonly xPx: number; readonly yPx: number }
): SurfacedCandidateObservation | null {
	runtimeChannel();
	const now = Date.now();
	let best: { observation: SurfacedCandidateObservation; distancePx: number } | null = null;
	for (let index = surfaced.length - 1; index >= 0; index -= 1) {
		const observation = surfaced[index];
		if (observation.kind !== kind || now - observation.observedAtMs > MAX_RECOMMENDATION_AGE_MS) continue;
		const distancePx = Math.hypot(observation.xPx - clickPx.xPx, observation.yPx - clickPx.yPx);
		if (distancePx > MAX_RECOMMENDATION_EVIDENCE_DISTANCE_PX) continue;
		if (!best || distancePx < best.distancePx) best = { observation, distancePx };
	}
	return best?.observation ?? null;
}

export interface CvFunnelRuntimeSnapshot {
	readonly surfacedCandidates: readonly SurfacedCandidateObservation[];
	readonly localSnaps: readonly LocalSnapTrace[];
}

/** Returns copies so console/test consumers cannot mutate runtime state. */
export function getCvFunnelRuntimeSnapshot(): CvFunnelRuntimeSnapshot {
	runtimeChannel();
	return { surfacedCandidates: [...surfaced], localSnaps: [...localSnaps] };
}

export function resetCvFunnelRuntime(): void {
	surfaced.length = 0;
	localSnaps.length = 0;
	sequence = 0;
}

export interface ChainSpotCvFunnelConsole {
	readonly snapshot: () => CvFunnelRuntimeSnapshot;
	readonly json: () => string;
	readonly reset: () => void;
}

/**
 * Console-only diagnostics surface. Example:
 *   chainspot.cvFunnel.snapshot()
 *   chainspot.cvFunnel.json()
 * This is intentionally not product UI and carries no authoritative state.
 */
function exposeConsoleHook(): void {
	if (typeof window === 'undefined') return;
	const root = window as typeof window & {
		chainspot?: Record<string, unknown> & { cvFunnel?: ChainSpotCvFunnelConsole };
	};
	const current = root.chainspot ?? {};
	current.cvFunnel = {
		snapshot: getCvFunnelRuntimeSnapshot,
		json: () => JSON.stringify(getCvFunnelRuntimeSnapshot(), null, 2),
		reset: resetCvFunnelRuntime
	};
	root.chainspot = current;
}

// BroadcastChannel does not replay messages sent before a listener exists.
// The detector worker imports this module before its first local-snap request,
// so eager initialization ensures it hears surfaced full-course evidence.
runtimeChannel();
exposeConsoleHook();
