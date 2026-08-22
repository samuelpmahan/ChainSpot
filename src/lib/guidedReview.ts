export interface Point {
	readonly xPx: number;
	readonly yPx: number;
}

// Structurally identical to courseDetect.ts's HoleProposal (kept as a local
// copy, not an import, so this module has zero dependency on that sibling
// task's file existing yet — any real HoleProposal[] from courseDetect.ts
// satisfies this type as-is).
export interface HoleProposal {
	readonly n: number;
	/** merged badge position, composite px — the hole's visual anchor */
	readonly badge: Point;
	readonly tee: Point | null;
	readonly basket: Point | null;
	readonly bends: readonly Point[];
}

export type Anchor = 'tee' | 'basket' | 'bend';

export interface ReviewHoleState {
	readonly n: number;
	readonly badge: Point;
	readonly tee: Point | null;
	readonly basket: Point | null;
	readonly bends: readonly Point[];
	readonly status: 'pending' | 'accepted';
	readonly replacements: { readonly tee: number; readonly basket: number; readonly bend: number };
}

export interface ReviewState {
	readonly holes: readonly ReviewHoleState[]; // queue order = ascending n, fixed at createReview()
	readonly currentIndex: number; // index of the hole under review; === holes.length when done
	readonly done: boolean;
}

export function createReview(proposals: readonly HoleProposal[]): ReviewState {
	// Sort a COPY of proposals ascending by n
	const sorted = [...proposals].sort((a, b) => a.n - b.n);

	// Map each to a ReviewHoleState with status:'pending', replacements:{tee:0,basket:0,bend:0}
	const holes: ReviewHoleState[] = sorted.map((proposal) => ({
		n: proposal.n,
		badge: proposal.badge,
		tee: proposal.tee,
		basket: proposal.basket,
		bends: proposal.bends,
		status: 'pending' as const,
		replacements: { tee: 0, basket: 0, bend: 0 }
	}));

	// currentIndex = index of first pending hole (0 for non-empty, holes.length for empty)
	const currentIndex = holes.length > 0 ? 0 : 0;

	// done = currentIndex >= holes.length
	const done = currentIndex >= holes.length;

	return { holes, currentIndex, done };
}

export function accept(state: ReviewState, holeN: number): ReviewState {
	// Find the hole with the given n
	const holeIndex = state.holes.findIndex((h) => h.n === holeN);

	// If no hole has that n, or it's already accepted, return the SAME state reference unchanged
	if (holeIndex === -1 || state.holes[holeIndex].status === 'accepted') {
		return state;
	}

	// Otherwise return a NEW ReviewState: new holes array where only the matched hole becomes
	// a NEW object with status:'accepted' (everything else on it unchanged)
	const newHoles: ReviewHoleState[] = state.holes.map((hole, idx) => {
		if (idx === holeIndex) {
			return { ...hole, status: 'accepted' as const };
		}
		return hole;
	});

	// Recompute currentIndex by scanning from START for first pending hole
	let currentIndex = 0;
	while (currentIndex < newHoles.length && newHoles[currentIndex].status !== 'pending') {
		currentIndex++;
	}

	// Recompute done
	const done = currentIndex >= newHoles.length;

	return { holes: newHoles, currentIndex, done };
}

export function replace(
	state: ReviewState,
	holeN: number,
	anchor: Anchor,
	p: Point
): ReviewState {
	// Find the hole with the given n
	const holeIndex = state.holes.findIndex((h) => h.n === holeN);

	// If no hole has that n, return state unchanged
	if (holeIndex === -1) {
		return state;
	}

	const hole = state.holes[holeIndex];

	// Build a new hole object based on which anchor
	let newHole: ReviewHoleState;
	if (anchor === 'tee') {
		newHole = {
			...hole,
			tee: p,
			replacements: { ...hole.replacements, tee: hole.replacements.tee + 1 },
			status: 'accepted' as const
		};
	} else if (anchor === 'basket') {
		newHole = {
			...hole,
			basket: p,
			replacements: { ...hole.replacements, basket: hole.replacements.basket + 1 },
			status: 'accepted' as const
		};
	} else {
		// anchor === 'bend'
		// This slice supports exactly ONE bend per hole
		newHole = {
			...hole,
			bends: [p],
			replacements: { ...hole.replacements, bend: hole.replacements.bend + 1 },
			status: 'accepted' as const
		};
	}

	// Create new holes array with the updated hole
	const newHoles: ReviewHoleState[] = state.holes.map((h, idx) => {
		if (idx === holeIndex) {
			return newHole;
		}
		return h;
	});

	// Recompute currentIndex by scanning from START for first pending hole
	let currentIndex = 0;
	while (currentIndex < newHoles.length && newHoles[currentIndex].status !== 'pending') {
		currentIndex++;
	}

	// Recompute done
	const done = currentIndex >= newHoles.length;

	return { holes: newHoles, currentIndex, done };
}

export function currentHole(state: ReviewState): ReviewHoleState | null {
	return state.holes[state.currentIndex] ?? null;
}
