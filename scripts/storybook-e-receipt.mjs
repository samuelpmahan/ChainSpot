import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { materializeBadgeSpecimens } from '../src/lib/server/evidence-workbench/materializeBadgeSpecimens.mjs';

const library = await materializeBadgeSpecimens();
const index = JSON.parse(readFileSync(resolve('storybook-static/index.json'), 'utf8'));
const entries = Object.values(index.entries);
const stories = entries.filter((entry) => entry.type === 'story');
const docs = entries.filter((entry) => entry.type === 'docs');
const pinned = library.specimens.find((specimen) => specimen.id === 'badge-0');
if (library.status !== 'materialized') throw new Error(library.note);
if (library.specimens.length !== 18)
	throw new Error(`expected 18 real specimens; got ${library.specimens.length}`);
if (!pinned) throw new Error('badge-0 missing from materialized specimen library');
if (!library.m1) throw new Error('M1 representation missing from materialized specimen library');
const m1Badge = library.m1.objects.find((object) => object.id === 'badge-0');
const m1Basket = library.m1.objects.find((object) => object.id === 'basket-0');
if (m1Badge?.accounting.status !== 'known' || m1Basket?.accounting.status !== 'known')
	throw new Error('representative Badge/Basket M1 accounting is unavailable');
const intakePcr = library.pcrs.find((pcr) => pcr.id === 'intake-pcr');
const badgePcr = library.pcrs.find((pcr) => pcr.id === 'badge-pcr');
const basketPcr = library.pcrs.find((pcr) => pcr.id === 'basket-pcr');
const visibleTeePcr = library.pcrs.find((pcr) => pcr.id === 'visible-tee-pcr');
const teeBasketLineworkPcr = library.pcrs.find((pcr) => pcr.id === 'tee-basket-linework-pcr');
const teeRecoveryPcr = library.pcrs.find((pcr) => pcr.id === 'tee-recovery-pcr');
const pcrs = [intakePcr, badgePcr, basketPcr, visibleTeePcr, teeBasketLineworkPcr, teeRecoveryPcr];
if (pcrs.some((pcr) => !pcr)) throw new Error('Expected S0-through-recovery PCR composition missing');
for (const pcr of pcrs) {
	if (!/^[0-9a-f]{64}$/.test(pcr.runResultId))
		throw new Error(`${pcr.id}: invalid frozen runResultId`);
	for (const tick of pcr.ticks) {
		if (tick.testimony.frozenCalculations.length === 0)
			throw new Error(`${pcr.id}/${tick.operation.id}: no frozen calculation`);
		if (tick.testimony.actualProduces.length === 0)
			throw new Error(`${pcr.id}/${tick.operation.id}: no actual PxC output`);
	}
}
const pcrStories = stories.filter((story) => story.title === 'LAB/PCR/Tick Inspection');
if (pcrStories.length !== 11)
	throw new Error(`expected 11 indexed PCR specimens; got ${pcrStories.length}`);

function asPcrReceipt(pcr) {
	return {
		runResultId: pcr.runResultId,
		ticks: pcr.ticks.map((tick) => ({
			id: tick.operation.id,
			calculations: tick.testimony.frozenCalculations,
			inputs: tick.testimony.actualConsumes,
			writes: tick.testimony.writes,
			materializations: tick.testimony.artifacts.map((artifact) => ({
				id: artifact.id,
				kind: artifact.kind,
				sha256: artifact.sha256
			}))
		}))
	};
}

const receipt = {
	source: library.source,
	specimens: library.specimens.length,
	indexedProjections: stories.length,
	composedNotebooks: docs.length,
	pcr: {
		indexedSpecimens: pcrStories.length,
		intake: asPcrReceipt(intakePcr),
		badge: asPcrReceipt(badgePcr),
		basket: asPcrReceipt(basketPcr),
		visibleTee: asPcrReceipt(visibleTeePcr),
		teeBasketLinework: asPcrReceipt(teeBasketLineworkPcr),
		teeRecovery: asPcrReceipt(teeRecoveryPcr)
	},
	pinnedBadge0: pinned.metrics,
	m1: {
		artifact: library.m1.artifact,
		primitiveComponents: library.m1.components.length,
		unconsumedPrimitiveComponents: library.m1.components.filter(
			(component) => component.consumers.length === 0
		).length,
		objects: library.m1.objects.length,
		assembled: library.m1.objects.filter((object) => object.accounting.status === 'known').length,
		unknown: library.m1.objects.filter((object) => object.accounting.status === 'unknown').length,
		basketShellFamilies: library.m1.basketShellFamilies,
		badge0: {
			available: m1Badge.accounting.availablePixels.length,
			explained: m1Badge.accounting.explainedPixels.length,
			unexplained: m1Badge.accounting.unexplainedPixels.length
		},
		basket0: {
			available: m1Basket.accounting.availablePixels.length,
			explained: m1Basket.accounting.explainedPixels.length,
			unexplained: m1Basket.accounting.unexplainedPixels.length
		}
	},
	provenance: pinned.provenance
};

mkdirSync(resolve('artifacts/storybook-e'), { recursive: true });
writeFileSync(
	resolve('artifacts/storybook-e/receipt.json'),
	`${JSON.stringify(receipt, null, 2)}\n`
);
console.log('STORYBOOK E RECEIPT');
console.log(`real specimens: ${receipt.specimens} (live DashsTrack materialization)`);
console.log(`indexed projections: ${receipt.indexedProjections} (storybook-static/index.json)`);
console.log(`composed notebooks: ${receipt.composedNotebooks} (storybook-static/index.json)`);
console.log(
	`PCR: ${receipt.pcr.indexedSpecimens} indexed specimens; Intake ${receipt.pcr.intake.ticks.length}; Badge ${receipt.pcr.badge.ticks.length}; Basket ${receipt.pcr.basket.ticks.length}; Visible Tee ${receipt.pcr.visibleTee.ticks.length}; TeeBasket Linework ${receipt.pcr.teeBasketLinework.ticks.length}; Tee Recovery ${receipt.pcr.teeRecovery.ticks.length} Ticks`
);
console.log(
	`PCR identities: Intake ${receipt.pcr.intake.runResultId}; Badge ${receipt.pcr.badge.runResultId}; Basket ${receipt.pcr.basket.runResultId}; Visible Tee ${receipt.pcr.visibleTee.runResultId}; TeeBasket Linework ${receipt.pcr.teeBasketLinework.runResultId}; Tee Recovery ${receipt.pcr.teeRecovery.runResultId}`
);
console.log(
	`badge-0: B+W ${pinned.metrics.ownedBw}; AA +${pinned.metrics.aaAdded}; residue ${pinned.metrics.residueBefore} -> ${pinned.metrics.residueAfter}`
);
console.log(
	`M1: ${receipt.m1.primitiveComponents} primitives (${receipt.m1.unconsumedPrimitiveComponents} unconsumed); objects ${receipt.m1.assembled} assembled + ${receipt.m1.unknown} UNKNOWN`
);
console.log(
	`M1 badge-0 ${receipt.m1.badge0.available}/${receipt.m1.badge0.explained}/${receipt.m1.badge0.unexplained}; basket-0 ${receipt.m1.basket0.available}/${receipt.m1.basket0.explained}/${receipt.m1.basket0.unexplained}`
);
console.log(
	`Basket shell family: ${receipt.m1.basketShellFamilies[0]?.id ?? 'UNKNOWN'} · ${receipt.m1.basketShellFamilies[0]?.relationshipIds.length ?? 0} relationships`
);
console.log('machine receipt: artifacts/storybook-e/receipt.json');
