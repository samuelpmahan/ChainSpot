import type { RunReceipt } from './runReceipt';

/**
 * Render the persisted run receipt as a compact, deterministic text report.
 *
 * This is deliberately a presentation-only view: values are read from the
 * receipt in their existing order and are not recomputed or re-aggregated,
 * apart from the artifact count (the receipt stores artifacts per operation).
 */

function value(value: unknown): string {
	return value === undefined || value === null ? 'UNKNOWN' : String(value);
}

function json(valueToSerialize: unknown): string {
	if (valueToSerialize === undefined || valueToSerialize === null) return 'UNKNOWN';
	return JSON.stringify(valueToSerialize);
}

function list(values: readonly unknown[]): string {
	return values.length === 0 ? '[]' : `[${values.map((item) => String(item)).join(', ')}]`;
}

function probes(receipt: RunReceipt['operations'][number]): string {
	return receipt.probes.length === 0
		? '[]'
		: receipt.probes.map((probe) => `${probe.name}=${value(probe.value)}`).join(', ');
}

function conformance(operation: RunReceipt['operations'][number]): string {
	if (operation.conformance.ok) return 'OK';
	return `DRIFT missingConsumes=${list(operation.conformance.missingConsumes)} missingProduces=${list(operation.conformance.missingProduces)}`;
}

/** Render a RunReceipt without emitting binary payloads or object rows. */
export function formatRunReceiptText(receipt: RunReceipt): string {
	const lines: string[] = [
		'RUN RECEIPT',
		`schema: ${receipt.schema}`,
		`generatedAt: ${receipt.generatedAt}`,
		`revision: ${receipt.revision}`,
		'',
		'IDENTITY / CONFIG / INTAKE',
		`config.name: ${receipt.config.name}`,
		`config.path: ${receipt.config.path}`,
		`config.paramsHash: ${receipt.config.paramsHash}`,
		`config.planFingerprint: ${receipt.config.planFingerprint}`,
		`config.throughGate: ${value(receipt.config.throughGate)}`,
		`config.enabledFeatures: ${list(receipt.config.enabledFeatures)}`,
		`config.deviatingFeatures: ${list(receipt.config.deviatingFeatures)}`,
		`intake.sources: ${list(receipt.intake.sources)}`,
		`intake.sourceImageIds: ${list(receipt.intake.sourceImageIds)}`,
		`intake.canonicalImageId: ${receipt.intake.canonicalImageId}`,
		`intake.widthPx: ${receipt.intake.widthPx}`,
		`intake.heightPx: ${receipt.intake.heightPx}`,
		`intake.sourceByteLength: ${receipt.intake.sourceByteLength}`,
		`intake.stripChrome.source: ${receipt.intake.stripChrome.source}`,
		`intake.stripChrome.insets: ${json(receipt.intake.stripChrome.insets)}`,
		`intake.autoStitch.sourceCount: ${receipt.intake.autoStitch.sourceCount}`,
		`intake.autoStitch.hadFallback: ${receipt.intake.autoStitch.hadFallback}`,
		`intake.autoStitch.placements: ${json(receipt.intake.autoStitch.placements)}`,
		`intake.ledger: ${json(receipt.intake.ledger)}`,
		`intake.truthMatch: ${json(receipt.intake.truthMatch)}`,
		'',
		'TIMING BREAKDOWN'
	];

	for (const name of [
		'configMs',
		'intakeMs',
		'canonicalWriteMs',
		'gatewayMs',
		'operationBodyMs',
		'artifactPersistenceMs',
		'artifactRenderMs',
		'truthEvaluationMs',
		'featureRenderMs',
		'observedTotalMs'
	] as const) {
		lines.push(`timings.${name}: ${receipt.timings[name]}`);
	}

	lines.push(
		'',
		'OPERATIONS (CHRONOLOGICAL)',
		'index | gate | id | durationMs | percentOfOperationBody | conformance | probes'
	);
	for (const operation of receipt.operations) {
		lines.push(
			`${operation.index} | ${operation.gate} | ${operation.id} | ${operation.durationMs} | ${operation.percentOfOperationBody} | ${conformance(operation)} | ${probes(operation)}`
		);
	}
	if (receipt.operations.length === 0) lines.push('(none)');

	lines.push(
		'',
		'CANONICAL GATE ROLLUPS',
		'gate | title | status | operationIndexes | durationMs | percentOfOperationBody'
	);
	for (const gate of receipt.gates) {
		lines.push(
			`${gate.gate} | ${gate.title} | ${gate.status} | ${list(gate.operationIndexes)} | ${gate.durationMs} | ${gate.percentOfOperationBody}`
		);
	}
	if (receipt.gates.length === 0) lines.push('(none)');

	lines.push('', 'UNIT RESULTS');
	for (const unit of receipt.units) {
		lines.push(
			`unit ${unit.id} gate=${unit.gate} durationMs=${unit.durationMs} accepted=${unit.accepted} rejected=${unit.rejected} info=${unit.info}`
		);
		for (const measurement of unit.measurements) {
			lines.push(
				`  measurement ${measurement.name}: n=${measurement.count} min=${measurement.min} max=${measurement.max} mean=${measurement.mean}`
			);
		}
		if (unit.measurements.length === 0) lines.push('  measurements: []');
		if (unit.rejectionReasons.length === 0) {
			lines.push('  rejectionReasons: []');
		} else {
			for (const rejection of unit.rejectionReasons) {
				lines.push(`  rejectionReason ${rejection.reason}: ${rejection.count}`);
			}
		}
	}
	if (receipt.units.length === 0) lines.push('(none)');

	lines.push('', 'FINAL RESULTS');
	for (const name of [
		'badges',
		'baskets',
		'visibleTees',
		'recoveredTees',
		'phantomTees',
		'totalTees',
		'assignments',
		'rawPairs'
	] as const) {
		lines.push(`results.${name}: ${value(receipt.results[name])}`);
	}

	lines.push('', 'TRUTH EVALUATION');
	lines.push(`evaluation.truthSupplied: ${receipt.evaluation.truthSupplied}`);
	lines.push(`evaluation.skipped: ${receipt.evaluation.skipped}`);
	lines.push(`evaluation.reason: ${value(receipt.evaluation.reason)}`);
	lines.push(`evaluation.scoreboard: ${json(receipt.evaluation.scoreboard)}`);

	if (receipt.straightTest) {
		lines.push('', 'G5 STRAIGHT TEST (SEALED TRACE)');
		const st = receipt.straightTest;
		lines.push(`featureId: ${st.featureId}`);
		lines.push(`runId: ${st.runId}`);
		lines.push(`imageId: ${st.imageId}`);
		lines.push(`paramsHash: ${st.paramsHash}`);
		lines.push(`traceHash: ${st.traceHash}`);
		lines.push(`coordinateFrame: ${st.coordinateFrame}`);
		lines.push(`truthMode: ${st.truthAssistance.mode}`);
		if (st.truthAssistance.taint) lines.push(st.truthAssistance.taint);
		lines.push(`truthAssistance: ${json(st.truthAssistance)}`);
		if (st.proposals.length === 0) lines.push('proposal: []');
		for (const proposal of st.proposals) {
			lines.push(`proposal ${proposal.proposalId}: ${json(proposal)}`);
			for (const reason of proposal.reasons) lines.push(`  reason: ${reason}`);
		}
	}

	lines.push('', 'VISUAL RENDERS', `visualRenderCount: ${receipt.visualRenders.length}`);
	lines.push('index | gate | kind | owner | status | id | summary');
	for (const [index, render] of receipt.visualRenders.entries()) {
		lines.push(
			`${index + 1} | ${render.gate} | ${render.kind} | ${render.owner} | ${render.status} | ${render.id} | ${render.summary}`
		);
		if (render.files.length === 0) lines.push('  files: []');
		else for (const file of render.files) lines.push(`  file: ${file}`);
	}
	if (receipt.visualRenders.length === 0) lines.push('(none)');

	lines.push('', 'WARNINGS');
	if (receipt.warnings.length === 0) lines.push('(none)');
	else for (const warning of receipt.warnings) lines.push(`- ${warning}`);

	const artifactRefs = receipt.operations.flatMap((operation) => operation.artifacts);
	lines.push('', 'ARTIFACTS', `artifactCount: ${artifactRefs.length}`);
	if (artifactRefs.length === 0) lines.push('(none)');
	else
		artifactRefs.forEach((artifact, index) =>
			lines.push(`artifact[${index + 1}].uri: ${artifact.uri}`)
		);

	return `${lines.join('\n')}\n`;
}
