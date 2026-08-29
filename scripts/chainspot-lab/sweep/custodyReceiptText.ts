import type { ChainOfCustodyLedger, TeeCustodyRecord } from '@chainspot/alg/detectors/threeFactor';

/**
 * Render a ChainOfCustodyLedger as a human report, in the same run.receipt.txt
 * family: presentation-only, nothing recomputed or re-scored, values read
 * straight off the ledger `buildChainOfCustody()` already produced.
 */

function assignmentHole(tee: TeeCustodyRecord): string | null {
	return (
		tee.events.find(
			(event): event is Extract<typeof event, { kind: 'assignment' }> => event.kind === 'assignment'
		)?.hole ?? null
	);
}

/** Numeric ascending by hole; UNASSIGNED (no hole) sorts last -- the same
 * "H7,H8,H18,H14..." string-sort-of-badge-id bug HOLE ASSIGNMENTS had. */
function holeSortKey(hole: string | null): number {
	const n = hole === null ? Number.NaN : Number(hole);
	return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}

function sortedByHole(tees: readonly TeeCustodyRecord[]): readonly TeeCustodyRecord[] {
	return [...tees].sort((a, b) => holeSortKey(assignmentHole(a)) - holeSortKey(assignmentHole(b)));
}

function tierLabel(originKind: TeeCustodyRecord['originKind']): string {
	switch (originKind) {
		case 'visible-ring':
			return 'ring';
		case 'visible-component':
			return 'component';
		case 'recovered':
			return 'recovered';
		default:
			return originKind;
	}
}

export interface CustodyReceiptCounts {
	readonly total: number;
	readonly visible: number;
	readonly recovered: number;
	readonly assigned: number;
	readonly unassigned: number;
	readonly chainsWithGaps: number;
}

export function summarizeCustody(custody: ChainOfCustodyLedger): CustodyReceiptCounts {
	let visible = 0;
	let recovered = 0;
	let assigned = 0;
	let unassigned = 0;
	let chainsWithGaps = 0;
	for (const tee of custody.tees) {
		if (tee.originKind === 'recovered') recovered += 1;
		else visible += 1;
		const hole = tee.events.find(
			(event): event is Extract<typeof event, { kind: 'assignment' }> => event.kind === 'assignment'
		)?.hole;
		if (hole) assigned += 1;
		else unassigned += 1;
		if (tee.gaps.length > 0) chainsWithGaps += 1;
	}
	return {
		total: custody.tees.length,
		visible,
		recovered,
		assigned,
		unassigned,
		chainsWithGaps
	};
}

export function formatCustodyReceiptText(custody: ChainOfCustodyLedger, runLabel: string): string {
	const lines: string[] = [];
	lines.push(`CHAIN OF CUSTODY — ${runLabel}`);
	lines.push(
		`schema=${custody.schema} runId=${custody.runId ?? 'UNKNOWN'} imageId=${custody.imageId ?? 'UNKNOWN'}`
	);
	lines.push(`traceAvailable=${custody.traceAvailable}`);
	lines.push(`totalTees=${custody.tees.length}`);
	lines.push('');

	for (const tee of sortedByHole(custody.tees)) {
		const assignmentEvent = tee.events.find(
			(event): event is Extract<typeof event, { kind: 'assignment' }> => event.kind === 'assignment'
		);
		const hole = assignmentEvent?.hole ?? null;
		lines.push(`tee=${tee.teeId} tier=${tierLabel(tee.originKind)} hole=${hole ?? 'UNASSIGNED'}`);
		lines.push(`  summary: ${tee.summary}`);
		lines.push(`  evidenceRefs: ${tee.evidenceRefs.join(', ')}`);
		if (tee.gaps.length > 0) {
			for (const gap of tee.gaps) lines.push(`  GAP: ${gap}`);
		} else {
			lines.push('  GAP: none (lineage complete)');
		}
		if (assignmentEvent) {
			lines.push(
				`  assignment: producer=${assignmentEvent.producerUnit} badge=${assignmentEvent.badgeId} basket=${assignmentEvent.basketId} score=${assignmentEvent.score} rank=${assignmentEvent.rank} ownership=${assignmentEvent.ownership}`
			);
		} else {
			lines.push('  assignment: UNASSIGNED (no assignment event in this run)');
		}
		lines.push(`  events: ${tee.events.length}`);
		lines.push('');
	}

	const counts = summarizeCustody(custody);
	lines.push('COUNTS');
	lines.push(`  total=${counts.total} visible=${counts.visible} recovered=${counts.recovered}`);
	lines.push(`  assigned=${counts.assigned} unassigned=${counts.unassigned}`);
	lines.push(`  chainsWithGaps=${counts.chainsWithGaps}`);
	lines.push('');

	return lines.join('\n') + '\n';
}
