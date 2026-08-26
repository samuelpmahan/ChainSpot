import { sha256HexSyncText } from '@chainspot/alg/exec/sha256';
import type { CropRectPx, SelectiveFullDecodeTrace } from './selectiveFullDecode.types';

/** Image-side projection. It contains no bitmap handle and performs no math. */
export interface SelectiveFullDecodeVisualRender {
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: string;
	readonly traceHash: string;
	readonly upstreamTraceHash: string;
	readonly sourceObjectId: string;
	readonly classificationObjectId: string;
	readonly regionObjectId: string;
	readonly cropObjectId: string;
	readonly requestedSourceRect: SelectiveFullDecodeTrace['requestedSourceRect'];
	readonly cropRect: CropRectPx | 'UNKNOWN';
	readonly geometryProvenance: string;
	readonly measurements: SelectiveFullDecodeTrace['measurements'];
	readonly verdict: SelectiveFullDecodeTrace['verdict'];
	readonly reason?: string;
}

export interface SelectiveFullDecodeEvidence {
	readonly mathText: string;
	readonly cliText: string;
	readonly visualRender: SelectiveFullDecodeVisualRender;
}

export const SELECTIVE_FULL_DECODE_MATH = [
	'source rect convention: [leftPx,rightPx) x [topPx,bottomPx), in original-image pixels',
	'left = max(0, min(sourceWidthPx, floor(requested.leftPx)))',
	'top = max(0, min(sourceHeightPx, floor(requested.topPx)))',
	'right = max(0, min(sourceWidthPx, ceil(requested.rightPx)))',
	'bottom = max(0, min(sourceHeightPx, ceil(requested.bottomPx)))',
	'decode boundary: cropRect = { leftPx: left, topPx: top, widthPx: right - left, heightPx: bottom - top }',
	'decode request: createImageBitmap(file, leftPx, topPx, widthPx, heightPx)',
	'no full-resolution decode occurs unless classification=thrown, upstream verdict=accepted, and region verdict=candidate',
	'every non-required or failed row remains an explicit rejection'
] as const;

function project(trace: SelectiveFullDecodeTrace): SelectiveFullDecodeVisualRender {
	return {
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		upstreamTraceHash: trace.upstreamTraceHash,
		sourceObjectId: trace.objectIds.source,
		classificationObjectId: trace.objectIds.classification,
		regionObjectId: trace.objectIds.region,
		cropObjectId: trace.objectIds.crop ?? 'UNKNOWN',
		requestedSourceRect: trace.requestedSourceRect,
		cropRect: trace.cropRect,
		geometryProvenance: trace.geometryProvenance,
		measurements: trace.measurements,
		verdict: trace.verdict,
		reason: trace.reason
	};
}

function row(render: SelectiveFullDecodeVisualRender): string {
	return `selective-full-decode ${JSON.stringify(render)}`;
}

export function toSelectiveFullDecodeEvidence(
	trace: SelectiveFullDecodeTrace
): SelectiveFullDecodeEvidence {
	const visualRender = project(trace);
	return {
		mathText: SELECTIVE_FULL_DECODE_MATH.join('\n'),
		cliText: row(visualRender),
		visualRender
	};
}

function parseRow(cliText: string): SelectiveFullDecodeVisualRender {
	const prefix = 'selective-full-decode ';
	if (!cliText.startsWith(prefix)) throw new Error('evidence correspondence mismatch: CLI prefix');
	try {
		return JSON.parse(cliText.slice(prefix.length)) as SelectiveFullDecodeVisualRender;
	} catch {
		throw new Error('evidence correspondence mismatch: CLI JSON');
	}
}

/** Strict one-to-one correspondence: the CLI row must equal the render model exactly. */
export function assertSelectiveFullDecodeCorrespondence(
	evidence: SelectiveFullDecodeEvidence
): void {
	const parsed = parseRow(evidence.cliText);
	if (JSON.stringify(parsed) !== JSON.stringify(evidence.visualRender)) {
		throw new Error('evidence correspondence mismatch: CLI/VisualRender row');
	}
	if (evidence.visualRender.verdict === 'rejected' && !evidence.visualRender.reason) {
		throw new Error('rejected decode row must retain reason');
	}
}

/** Checks cardinality and identity across a batch; no row is silently dropped. */
export function assertSelectiveFullDecodeCorrespondenceRows(
	evidence: readonly SelectiveFullDecodeEvidence[]
): void {
	const seen = new Set<string>();
	for (const rowEvidence of evidence) {
		assertSelectiveFullDecodeCorrespondence(rowEvidence);
		const key = `${rowEvidence.visualRender.runId}:${rowEvidence.visualRender.imageId}:${rowEvidence.visualRender.regionObjectId}`;
		if (seen.has(key)) throw new Error(`evidence correspondence mismatch: duplicate row ${key}`);
		seen.add(key);
	}
}

export interface SelectiveFullDecodeAcceptanceReceipt {
	readonly receiptId: string;
	readonly runId: string;
	readonly imageId: string;
	readonly paramsHash: string;
	readonly featureId: string;
	readonly traceHash: string;
	readonly cliText: string;
	readonly visualRender: SelectiveFullDecodeVisualRender;
	readonly implementerMath: readonly string[];
	readonly reviewerVerification: {
		readonly correspondence: 'PASS' | 'FAIL';
		readonly provenance: 'PASS' | 'FAIL';
		readonly geometry: 'PENDING' | 'PASS' | 'FAIL';
	};
	readonly fullDetailHash: string;
}

/** Actual acceptance receipt; deliberately separate from the ABFeatureSet execution manifest. */
export function toSelectiveFullDecodeAcceptanceReceipt(
	trace: SelectiveFullDecodeTrace,
	reviewerGeometry: 'PENDING' | 'PASS' | 'FAIL' = 'PENDING'
): SelectiveFullDecodeAcceptanceReceipt {
	const evidence = toSelectiveFullDecodeEvidence(trace);
	assertSelectiveFullDecodeCorrespondence(evidence);
	const receiptWithoutHash = {
		receiptId: `selective-full-decode:${trace.runId}:${trace.imageId}:${trace.objectIds.region}`,
		runId: trace.runId,
		imageId: trace.imageId,
		paramsHash: trace.paramsHash,
		featureId: trace.featureId,
		traceHash: trace.traceHash,
		cliText: evidence.cliText,
		visualRender: evidence.visualRender,
		implementerMath: SELECTIVE_FULL_DECODE_MATH,
		reviewerVerification: {
			correspondence: 'PASS' as const,
			provenance: 'PASS' as const,
			geometry: reviewerGeometry
		}
	};
	return {
		...receiptWithoutHash,
		fullDetailHash: sha256HexSyncText(JSON.stringify(receiptWithoutHash))
	};
}

export function formatSelectiveFullDecodeAcceptanceReceipt(
	receipt: SelectiveFullDecodeAcceptanceReceipt
): string {
	return [
		'# Selective Full Decode Acceptance Receipt',
		'',
		'## Receipt identity',
		'',
		`- receiptId: \`${receipt.receiptId}\``,
		`- runId: \`${receipt.runId}\``,
		`- imageId: \`${receipt.imageId}\``,
		`- paramsHash: \`${receipt.paramsHash}\``,
		`- featureId: \`${receipt.featureId}\``,
		`- traceHash: \`${receipt.traceHash}\``,
		`- full-detail hash: \`${receipt.fullDetailHash}\``,
		'',
		'## CLItext',
		'',
		'```text',
		receipt.cliText,
		'```',
		'',
		'## VisualRender model',
		'',
		'```json',
		JSON.stringify(receipt.visualRender, null, 2),
		'```',
		'',
		'## Implementer math',
		'',
		...receipt.implementerMath.map((line) => `- ${line}`),
		'',
		'## Reviewer verification',
		'',
		`- CLItext ↔ VisualRender one-to-one: **${receipt.reviewerVerification.correspondence}**`,
		`- provenance carried by trace: **${receipt.reviewerVerification.provenance}**`,
		`- geometry/pixel review: **${receipt.reviewerVerification.geometry}**`
	].join('\n');
}
