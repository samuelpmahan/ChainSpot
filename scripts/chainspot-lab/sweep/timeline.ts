// Per-operation timeline, grouped by gate (the "testimony" view: what each
// operation actually did, in the order it ran) plus a compact plan display
// (the "attrition"-adjacent view: what the compiler decided to run and why,
// before any of it executes). Presentation only -- every field printed here
// comes straight off a CompiledExecutionPlan/Receipt @chainspot/alg already
// produced; nothing is derived or recomputed.

import type { CompiledExecutionPlan } from '@chainspot/alg/exec';
import type { Receipt } from '@chainspot/alg/exec';
import { GATE_ORDER, gateLabel } from './gateVocabulary';

export function printPlan(plan: CompiledExecutionPlan): void {
	console.log(`--- Compiled plan (fingerprint ${plan.planFingerprint.slice(0, 16)}...) ---`);
	console.log(`  ${plan.ops.length} operations across ${new Set(plan.ops.map((op) => op.gate)).size} gates`);
	for (const gate of GATE_ORDER) {
		const ops = plan.ops.filter((op) => op.gate === gate);
		if (ops.length === 0) continue;
		console.log(`  ${gateLabel(gate)}:`);
		for (const op of ops) {
			const featureNote = op.features && op.features.length > 0 ? ` [${op.features.join(', ')}]` : '';
			console.log(`    ${op.id} (${op.kind}, unit ${op.unit})${featureNote}`);
			console.log(`      consumes: ${op.consumes.join(', ') || '(none)'}`);
			console.log(`      produces: ${op.produces.join(', ') || '(none)'}`);
		}
	}
	const enabledFeatures = Object.entries(plan.bindings).filter(([, b]) => b.enabled);
	console.log(`  enabled features: ${enabledFeatures.length > 0 ? enabledFeatures.map(([id]) => id).join(', ') : '(none beyond registry defaults)'}`);
}

interface ConformanceResult {
	readonly ok: boolean;
	readonly missingConsumes: readonly string[];
	readonly missingProduces: readonly string[];
}

function checkConformance(receipt: Receipt): ConformanceResult {
	const actualConsumes = new Set(receipt.actualConsumes);
	const actualProduces = new Set(receipt.actualProduces);
	const missingConsumes = receipt.declaredConsumes.filter((s) => !actualConsumes.has(s));
	const missingProduces = receipt.declaredProduces.filter((s) => !actualProduces.has(s));
	return { ok: missingConsumes.length === 0 && missingProduces.length === 0, missingConsumes, missingProduces };
}

/** Prints the operation timeline in execution order. The receipt at index i
 * is evidence for plan.ops[i]; receipt ids are checked, never used to remap
 * the timeline. Returns receipts with conformance or ordering drift, for the
 * caller's summary line. */
export function printTimeline(plan: CompiledExecutionPlan, receipts: readonly Receipt[]): readonly Receipt[] {
	const drifted: Receipt[] = [];

	console.log('--- Operation timeline (chronological) ---');
	let previousGate: string | undefined;
	for (const [index, op] of plan.ops.entries()) {
		if (op.gate !== previousGate) {
			console.log(`  ${gateLabel(op.gate)}:`);
			previousGate = op.gate;
		}

		const receipt = receipts[index];
		if (!receipt) {
			console.log(`    ${op.id}: NO RECEIPT (did not run)`);
			continue;
		}
		if (receipt.opId !== op.id) {
			console.log(
				`    !!! RECEIPT MISMATCH at index ${index}: expected '${op.id}', got '${receipt.opId}' !!!`
			);
			console.log(`    ${op.id}: NO RECEIPT (index evidence belongs to '${receipt.opId}')`);
			drifted.push(receipt);
			continue;
		}

		const conformance = checkConformance(receipt);
		if (!conformance.ok) drifted.push(receipt);
		const conformanceNote = conformance.ok
			? 'OK'
			: `DRIFT (missing consumes=[${conformance.missingConsumes.join(',')}] produces=[${conformance.missingProduces.join(',')}])`;
		console.log(`    ${op.id}  ${receipt.durationMs.toFixed(2)}ms  conformance=${conformanceNote}`);
		if (receipt.probes.length > 0) {
			console.log(`      probes: ${receipt.probes.map((p) => `${p.name}=${p.value}`).join(', ')}`);
		}
		if (receipt.artifacts.length > 0) {
			for (const a of receipt.artifacts) {
				console.log(`      artifact: [${a.kind}] ${a.id} sha256=${a.sha256.slice(0, 12)}... -> ${a.uri}`);
			}
		}
	}

	for (let index = plan.ops.length; index < receipts.length; index++) {
		const receipt = receipts[index];
		console.log(
			`    !!! RECEIPT MISMATCH at index ${index}: no planned operation, got '${receipt.opId}' !!!`
		);
		drifted.push(receipt);
	}

	const totalMs = receipts.reduce((n, r) => n + r.durationMs, 0);
	const totalArtifacts = receipts.reduce((n, r) => n + r.artifacts.length, 0);
	console.log(`  --- ${receipts.length} ops, ${totalMs.toFixed(2)}ms total, ${totalArtifacts} artifacts, ${drifted.length} conformance drift(s) ---`);
	return drifted;
}
