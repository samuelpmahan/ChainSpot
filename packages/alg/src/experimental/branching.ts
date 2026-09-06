/** Deterministic, default-OFF primitives for continuous experimental probing. */
export type Point = { x: number; y: number };
export type Heading = { x: number; y: number };
export type ReadingStatus = 'visible' | 'loss' | 'unknown';
export type ObservationStatus = 'accepted' | 'rejected' | 'unknown';
export type ProbeMeasurement = { readonly name: string; readonly value: number };
export type ProbeRead =
	| ReadingStatus
	| { readonly status: ReadingStatus; readonly measurements?: readonly ProbeMeasurement[] };
export type ProbeReader = (position: Point, heading: Heading) => ProbeRead;
export type InitialReading = {
	position: Point;
	heading: Heading;
	distancePx: 3 | 4;
	status: ReadingStatus;
};
export type Observation = {
	id: string;
	parentId: string | null;
	position: Point;
	heading: Heading;
	status: ObservationStatus;
	reason?: string;
	measurements?: readonly ProbeMeasurement[];
	target?: Point;
	proposalId?: string;
};
export type HeadingVariant = { offsetRadians: number; heading: Heading };
/** position is the next reader pose; target is the full, unshortened proposal. */
export type Proposal = {
	position: Point;
	parentId: string | null;
	seed: number;
	heading?: Heading;
	target?: Point;
	proposalId?: string;
	kind?: 'source-3' | 'source-4' | 'continue' | 'branch';
};
export type ProposalDestination = { id: string; ancestorId: string; position: Point; seed: number };
export type BranchingOptions = {
	origin: Point;
	heading: Heading;
	reader: ProbeReader;
	seed?: number;
	proposalCount?: number;
	proposalRadiusPx?: number;
	proposalMinDistancePx?: number;
	headingOffsetsRadians?: readonly number[];
	/** New reader operations for this invocation. */ maxObservations?: number;
};
export type BranchingContinuation = {
	version: 1;
	status: 'PAUSED';
	seed: number;
	rngState: number;
	nextId: number;
	queue: Proposal[];
	observations: Observation[];
	origin: Point;
	heading: Heading;
	proposalCount: number;
	proposalRadiusPx: number;
	proposalMinDistancePx: number;
	headingOffsetsRadians: number[];
	frontier: Proposal[];
	proposalDestinations: ProposalDestination[];
	visited: string[];
	headingCursor: number;
	armStepCursor: number;
};
export type BranchingRun = {
	status: 'COMPLETE' | 'PAUSED';
	observations: Observation[];
	continuation?: BranchingContinuation;
};
const TAU = Math.PI * 2,
	OFFSETS = [-Math.PI / 12, 0, Math.PI / 12] as const;
const cp = (p: Point): Point => ({ x: p.x, y: p.y });
const ch = (h: Heading): Heading => ({ x: h.x, y: h.y });
function norm(h: Heading): Heading {
	const n = Math.hypot(h.x, h.y);
	return n ? { x: h.x / n, y: h.y / n } : { x: 1, y: 0 };
}
function pose(p: Point, h: Heading, d: number): Point {
	return { x: p.x + h.x * d, y: p.y + h.y * d };
}
function key(p: Point, h: Heading): string {
	return `${p.x}|${p.y}|${h.x}|${h.y}`;
}
function rot(h: Heading, a: number): Heading {
	return { x: h.x * Math.cos(a) - h.y * Math.sin(a), y: h.x * Math.sin(a) + h.y * Math.cos(a) };
}
/** Reads exactly the two small source offsets. */
export function readInitialReadings(
	origin: Point,
	heading: Heading,
	reader: ProbeReader
): InitialReading[] {
	const h = norm(heading);
	return ([3, 4] as const).map((distancePx) => {
		const position = pose(origin, h, distancePx),
			r = reader(position, h);
		return { position, heading: h, distancePx, status: typeof r === 'string' ? r : r.status };
	});
}
export function headingVariants(
	heading: Heading,
	offsetsRadians: readonly number[] = OFFSETS
): HeadingVariant[] {
	const h = norm(heading);
	return offsetsRadians.map((offsetRadians) => ({ offsetRadians, heading: rot(h, offsetRadians) }));
}
export function nextSeeded(seed: number): { value: number; state: number } {
	let state = (seed >>> 0) + 0x6d2b79f5;
	state >>>= 0;
	let t = state;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state };
}
/** Public deterministic Poisson sampler kept for existing experiment callers. */
export function proposeLossTriggeredPositions(input: {
	parent: Observation;
	count: number;
	radiusPx: number;
	minDistancePx: number;
	seed: number;
}): Proposal[] {
	if (input.parent.status !== 'rejected') return [];
	const out: Proposal[] = [];
	let s = input.seed >>> 0;
	for (let i = 0; i < Math.max(32, input.count * 80) && out.length < input.count; i++) {
		const a = nextSeeded(s);
		s = a.state;
		const r = nextSeeded(s);
		s = r.state;
		const position = {
			x: input.parent.position.x + Math.cos(a.value * TAU) * Math.sqrt(r.value) * input.radiusPx,
			y: input.parent.position.y + Math.sin(a.value * TAU) * Math.sqrt(r.value) * input.radiusPx
		};
		if (
			out.every(
				(q) =>
					Math.hypot(q.position.x - position.x, q.position.y - position.y) >= input.minDistancePx
			)
		)
			out.push({ position, parentId: input.parent.id, seed: s });
	}
	return out;
}
export type RayDiagnosticInput = { direction: Heading; normal: Heading; widthPx: number };
export type ReflectedRayDiagnostic = {
	normal: Heading;
	incidenceRadians: number;
	incidenceDegrees: number;
	widthPx: number;
	reflectedDirection: Heading;
	autoBend: false;
};
export function diagnoseReflectedRay(input: RayDiagnosticInput): ReflectedRayDiagnostic {
	const d = norm(input.direction),
		n = norm(input.normal),
		dot = d.x * n.x + d.y * n.y,
		incidenceRadians = Math.acos(Math.max(-1, Math.min(1, Math.abs(dot))));
	return {
		normal: n,
		incidenceRadians,
		incidenceDegrees: (incidenceRadians * 180) / Math.PI,
		widthPx: input.widthPx,
		reflectedDirection: norm({ x: d.x - 2 * dot * n.x, y: d.y - 2 * dot * n.y }),
		autoBend: false
	};
}
type State = Omit<BranchingContinuation, 'version' | 'status'>;
function cloneTask(t: Proposal): Proposal {
	return {
		...t,
		position: cp(t.position),
		...(t.heading ? { heading: ch(t.heading) } : {}),
		...(t.target ? { target: cp(t.target) } : {})
	};
}
function cloneObs(o: Observation): Observation {
	return {
		...o,
		position: cp(o.position),
		heading: ch(o.heading),
		...(o.target ? { target: cp(o.target) } : {}),
		...(o.measurements ? { measurements: o.measurements.map((m) => ({ ...m })) } : {})
	};
}
function cloneDest(p: ProposalDestination): ProposalDestination {
	return { ...p, position: cp(p.position) };
}
function nextStep(s: State): number {
	const v = s.armStepCursor % 2 === 0 ? 3 : 4;
	s.armStepCursor++;
	return v;
}
/** Schedules once; identity uses exact pose AND heading, preserving narrow variants. */
function enqueue(s: State, t: Proposal): void {
	const heading = norm(t.heading ?? s.heading),
		task = {
			...t,
			position: cp(t.position),
			heading,
			...(t.target ? { target: cp(t.target) } : {})
		},
		k = key(task.position, heading);
	if (s.visited.includes(k)) return;
	s.visited.push(k);
	s.queue.push(task);
}
function ancestor(o: Observation, byId: ReadonlyMap<string, Observation>): Observation | undefined {
	let p = o.parentId ? byId.get(o.parentId) : undefined;
	while (p) {
		if (p.status === 'accepted') return p;
		p = p.parentId ? byId.get(p.parentId) : undefined;
	}
	return undefined;
}
/** Generates destinations in full proposal space, then schedules only a 3–4px sample toward each. */
function fork(s: State, parent: Observation): void {
	if (s.proposalCount <= 0) return;
	let rng = s.rngState,
		n = 0;
	const prior = s.proposalDestinations.filter((p) => p.ancestorId === parent.id);
	for (let i = 0; i < Math.max(32, s.proposalCount * 80) && n < s.proposalCount; i++) {
		const a = nextSeeded(rng);
		rng = a.state;
		const r = nextSeeded(rng);
		rng = r.state;
		const offset = s.headingOffsetsRadians.length
			? s.headingOffsetsRadians[s.headingCursor++ % s.headingOffsetsRadians.length]
			: 0;
		const angle = a.value * TAU + offset;
		const target = {
			x: parent.position.x + Math.cos(angle) * Math.sqrt(r.value) * s.proposalRadiusPx,
			y: parent.position.y + Math.sin(angle) * Math.sqrt(r.value) * s.proposalRadiusPx
		};
		if (
			prior.some(
				(p) =>
					Math.hypot(p.position.x - target.x, p.position.y - target.y) < s.proposalMinDistancePx
			)
		)
			continue;
		const heading = norm({ x: target.x - parent.position.x, y: target.y - parent.position.y }),
			proposal = {
				id: `proposal-${s.nextId}-${s.proposalDestinations.length}`,
				ancestorId: parent.id,
				position: target,
				seed: rng
			};
		s.proposalDestinations.push(proposal);
		prior.push(proposal);
		n++;
		enqueue(s, {
			position: pose(parent.position, heading, nextStep(s)),
			parentId: parent.id,
			seed: rng,
			heading,
			target,
			proposalId: proposal.id,
			kind: 'branch'
		});
	}
	s.rngState = rng;
}
function observe(id: string, t: Proposal, reader: ProbeReader): Observation {
	const heading = norm(t.heading ?? { x: 1, y: 0 }),
		raw = reader(t.position, heading),
		status = typeof raw === 'string' ? raw : raw.status,
		measurements = typeof raw === 'string' ? undefined : raw.measurements;
	const common = {
		id,
		parentId: t.parentId,
		position: cp(t.position),
		heading,
		...(t.target ? { target: cp(t.target) } : {}),
		...(t.proposalId ? { proposalId: t.proposalId } : {}),
		...(measurements ? { measurements: measurements.map((m) => ({ ...m })) } : {})
	};
	return status === 'visible'
		? { ...common, status: 'accepted' }
		: status === 'unknown'
			? { ...common, status: 'unknown', reason: 'reading-unknown' }
			: {
					...common,
					status: 'rejected',
					reason: t.parentId ? 'reading-loss' : 'unresolved-initial-loss'
				};
}
function initial(options: BranchingOptions, continuation?: BranchingContinuation): State {
	if (continuation)
		return {
			seed: continuation.seed,
			rngState: continuation.rngState,
			nextId: continuation.nextId,
			queue: continuation.queue.map(cloneTask),
			observations: continuation.observations.map(cloneObs),
			origin: cp(continuation.origin),
			heading: norm(continuation.heading),
			proposalCount: continuation.proposalCount ?? options.proposalCount ?? 8,
			proposalRadiusPx: continuation.proposalRadiusPx,
			proposalMinDistancePx: continuation.proposalMinDistancePx,
			headingOffsetsRadians: [...continuation.headingOffsetsRadians],
			frontier: continuation.frontier.map(cloneTask),
			proposalDestinations: (continuation.proposalDestinations ?? []).map(cloneDest),
			visited: [...continuation.visited],
			headingCursor: continuation.headingCursor,
			armStepCursor: continuation.armStepCursor
		};
	const s: State = {
		seed: options.seed ?? 1,
		rngState: options.seed ?? 1,
		nextId: 0,
		queue: [],
		observations: [],
		origin: cp(options.origin),
		heading: norm(options.heading),
		proposalCount: options.proposalCount ?? 8,
		proposalRadiusPx: options.proposalRadiusPx ?? 12,
		proposalMinDistancePx: options.proposalMinDistancePx ?? 3,
		headingOffsetsRadians: [...(options.headingOffsetsRadians ?? OFFSETS)],
		frontier: [],
		proposalDestinations: [],
		visited: [],
		headingCursor: 0,
		armStepCursor: 0
	};
	enqueue(s, {
		position: pose(s.origin, s.heading, 3),
		parentId: null,
		seed: s.rngState,
		heading: s.heading,
		kind: 'source-3'
	});
	return s;
}
function paused(s: State): BranchingContinuation {
	const queue = s.queue.map(cloneTask);
	return {
		version: 1,
		status: 'PAUSED',
		...s,
		queue,
		frontier: queue.map(cloneTask),
		observations: s.observations.map(cloneObs),
		proposalDestinations: s.proposalDestinations.map(cloneDest),
		visited: [...s.visited],
		origin: cp(s.origin),
		heading: ch(s.heading),
		headingOffsetsRadians: [...s.headingOffsetsRadians]
	};
}
export function serializeContinuation(continuation: BranchingContinuation): string {
	return JSON.stringify(continuation);
}
export function deserializeContinuation(serialized: string): BranchingContinuation {
	const v: unknown = JSON.parse(serialized);
	if (
		!v ||
		typeof v !== 'object' ||
		(v as { version?: unknown }).version !== 1 ||
		(v as { status?: unknown }).status !== 'PAUSED'
	)
		throw new Error('Invalid PAUSED branching continuation');
	return v as BranchingContinuation;
}
/** Each popped task invokes reader once. Accepted observations continue their own heading only; a loss forks from that loss's own accepted ancestry. */
export function runBranchingProbe(
	options: BranchingOptions,
	continuation?: BranchingContinuation
): BranchingRun {
	const s = initial(options, continuation),
		budget = options.maxObservations ?? Infinity;
	let operations = 0;
	while (s.queue.length && operations < budget) {
		const task = s.queue.shift()!,
			id =
				task.kind === 'source-3'
					? 'initial-3'
					: task.kind === 'source-4'
						? 'initial-4'
						: `observation-${s.nextId++}`,
			o = observe(id, task, options.reader);
		s.observations.push(o);
		operations++;
		if (o.status === 'accepted') {
			if (task.kind === 'source-3')
				enqueue(s, {
					position: pose(s.origin, s.heading, 4),
					parentId: o.id,
					seed: s.rngState,
					heading: s.heading,
					kind: 'source-4'
				});
			else
				enqueue(s, {
					position: pose(o.position, o.heading, nextStep(s)),
					parentId: o.id,
					seed: s.rngState,
					heading: o.heading,
					...(task.target ? { target: task.target } : {}),
					...(task.proposalId ? { proposalId: task.proposalId } : {}),
					kind: 'continue'
				});
		} else if (o.status === 'rejected') {
			const p = ancestor(o, new Map(s.observations.map((x) => [x.id, x])));
			if (p) fork(s, p);
			else if (task.kind === 'source-3')
				enqueue(s, {
					position: pose(s.origin, s.heading, 4),
					parentId: null,
					seed: s.rngState,
					heading: s.heading,
					kind: 'source-4'
				});
		}
	}
	return s.queue.length
		? { status: 'PAUSED', observations: s.observations.map(cloneObs), continuation: paused(s) }
		: { status: 'COMPLETE', observations: s.observations.map(cloneObs) };
}
export function resumeBranchingProbe(
	serialized: string,
	options: Omit<BranchingOptions, 'origin' | 'heading'> &
		Partial<Pick<BranchingOptions, 'origin' | 'heading'>>
): BranchingRun {
	const continuation = deserializeContinuation(serialized);
	return runBranchingProbe(
		{
			...options,
			origin: options.origin ?? continuation.origin,
			heading: options.heading ?? continuation.heading
		},
		continuation
	);
}
