import type { LandmarkKind } from './landmarkTrace';

export type SemanticAnchorId = 'tee-component-centroid' | 'basket-stem-base';

export interface SemanticAnchorContract {
	readonly id: SemanticAnchorId;
	readonly kind: LandmarkKind;
	readonly definition: string;
	/** Whether downstream geometry has an explicit executable semantic requirement today. */
	readonly downstreamContractExplicit: boolean;
}

export const TEE_SEMANTIC_ANCHOR: SemanticAnchorContract = Object.freeze({
	id: 'tee-component-centroid',
	kind: 'tee',
	definition:
		'Current CV coordinate: centroid of the retained tee-pad component. This is a stable localization point, but ChainSpot does not yet define whether downstream geometry semantically wants pad center, launch edge, or another launch point.',
	downstreamContractExplicit: false
});

export const BASKET_SEMANTIC_ANCHOR: SemanticAnchorContract = Object.freeze({
	id: 'basket-stem-base',
	kind: 'basket',
	definition:
		'Basket stem/base at the bottom of the detected basket glyph: x is the component bounding-box center and y is the component maximum y. Course grammar explicitly consumes basket stem/base coordinates, not icon center.',
	downstreamContractExplicit: true
});

export function semanticAnchorFor(kind: LandmarkKind): SemanticAnchorContract {
	return kind === 'tee' ? TEE_SEMANTIC_ANCHOR : BASKET_SEMANTIC_ANCHOR;
}
