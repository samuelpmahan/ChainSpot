import { acquireObjectGraphV1, type CourseObject } from '../objects';
import type { BadgeStageResult } from '../badgeStage';
import type { BadgeEvidence, BasketEvidence, TeeEvidence } from '../types';
import type { ABFeature, EngineUnit, EvidenceBoard, FeatureContext } from './types';
import { objectPerimetersV1Render } from './g3.objectPerimetersV1Receipt';

export const objectPerimetersV1Feature = {
	id: 'objectPerimetersV1',
	gate: 'G3',
	kind: 'deviation',
	defaultEnabled: false,
	resolveOnlyWhenConfigured: true,
	note: 'V1 clean-object acquisition from already-computed masked connected components. Tee/badge outside is bright; basket outside is dark. Overlap/recovery fails loudly for V2.',
	render: objectPerimetersV1Render,
	knobs: {}
} satisfies ABFeature;

interface ViewportSlot {
	readonly topPx: number;
}

function decodePixels(packed: Uint32Array, width: number): readonly (readonly [number, number])[] {
	return Array.from(packed, (index) => [index % width, Math.floor(index / width)] as const);
}

function emitObject(ctx: FeatureContext, object: CourseObject): void {
	const assembly = object.raster.componentAssembly;
	if (!assembly) {
		ctx.overlay('objectPerimetersV1', {
			type: 'box',
			bbox: object.raster.bbox,
			verdict: 'rejected',
			ref: object.id,
			reason: 'V1 failure: component-backed object ownership is unavailable',
			metadata: { role: 'v1-failure', objectKind: object.kind }
		});
		return;
	}
	if (assembly.status === 'failed') {
		ctx.overlay('objectPerimetersV1', {
			type: 'box',
			bbox: assembly.seedBbox,
			verdict: 'rejected',
			ref: object.id,
			reason: `V2: ${assembly.reason}`,
			metadata: { role: 'v1-failure', objectKind: object.kind }
		});
		return;
	}
	const owned = decodePixels(assembly.ownedPixels, assembly.rasterWidth);
	const perimeter = decodePixels(assembly.perimeterPixels, assembly.rasterWidth);
	ctx.overlay('objectPerimetersV1', {
		type: 'pixelSet',
		pixels: owned,
		verdict: 'info',
		ref: object.id,
		values: { pixelCount: owned.length },
		metadata: {
			role: 'owned-union',
			objectKind: object.kind,
			outerPolarity: assembly.outerComponent.polarity
		}
	});
	ctx.overlay('objectPerimetersV1', {
		type: 'pixelSet',
		pixels: perimeter,
		verdict: 'accepted',
		ref: object.id,
		values: { perimeterPixelCount: perimeter.length },
		metadata: {
			role: 'canonical-perimeter',
			objectKind: object.kind,
			outerPolarity: assembly.outerComponent.polarity
		}
	});
}

export const objectPerimetersV1Unit: EngineUnit = {
	id: 'objectPerimetersV1',
	gate: 'G3',
	consumes: ['stage', 'badges', 'baskets', 'tees', 'viewport'],
	produces: ['objectPerimetersV1'],
	note: 'Materialize exact V1 object ownership from detector-stage bright/dark CC labels; no recovery, splitting, fitting, or re-thresholding.',
	run(board: EvidenceBoard, ctx: FeatureContext) {
		const stop = ctx.span('objectPerimetersV1');
		const state = ctx.resolve(objectPerimetersV1Feature);
		if (!state.enabled) {
			board.set('objectPerimetersV1', null);
			stop();
			return;
		}
		const stage = board.get<BadgeStageResult>('stage');
		const badges = board.get<readonly BadgeEvidence[]>('badges');
		const baskets = board.get<readonly BasketEvidence[]>('baskets');
		const tees = board.get<readonly TeeEvidence[]>('tees');
		const viewport = board.get<ViewportSlot>('viewport');
		const measurement = {
			badges,
			baskets,
			tees,
			viewport,
			parameters: {}
		} as never;
		const graph = acquireObjectGraphV1(measurement, {
			width: stage.width,
			height: stage.height,
			brightLabels: stage.brightLabels,
			darkLabels: stage.darkLabels,
			brightComponents: stage.brightComponents,
			darkComponents: stage.darkComponents
		});
		for (const object of [...graph.badges, ...graph.baskets, ...graph.tees]) emitObject(ctx, object);
		const successes = [...graph.badges, ...graph.baskets, ...graph.tees].filter(
			(object) => object.raster.componentAssembly?.status === 'assembled'
		).length;
		const failures = graph.badges.length + graph.baskets.length + graph.tees.length - successes;
		ctx.measure('objectPerimetersV1', 'assembledObjects', successes);
		ctx.measure('objectPerimetersV1', 'v1Failures', failures);
		board.set('objectPerimetersV1', graph);
		stop();
	}
};
