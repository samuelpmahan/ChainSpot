// g1.badges — badge-family detection (aspect/dark-interior/size-family
// gates) and dark-plate glyph recovery, extracted from badgeStage.ts, plus
// the badge-bbox exclusion padding used by measure.ts's tee rejection
// (insideBadge). Baseline: default ON, knobs always apply, defaults
// byte-equal to the pre-extraction literals.
//
// badgeSizeTolFactor is the human-readable knob (1.15); Math.log(...) stays
// at the anchoredFamilies use site in badgeStage.ts per knob-inventory merge
// note 4, not baked into a pre-logged constant. badgeAspectMin (1.15) and
// badgeSizeTolFactor (1.15) are coincidentally equal, separate knobs.
// plateInteriorMargin and plateBboxMargin are also coincidentally both 4,
// separate knobs.
//
// badgeInsidePadding: measure.ts's makeTees rejects any tee ring/component
// candidate found inside a badge bbox (+padding), and narrates the reject
// with a reason string that used to hard-code "+3px pad". That string is
// now templated from this knob (`(+${knobs.badgeInsidePadding}px pad)`) —
// a deliberate exception to leaving rejection narration untouched, so the
// scrubber's "why 0 tees?" answer never lies about the padding actually
// used when this knob is configured away from its default.

import type { ABFeature } from './types';

export const g1BadgesFeature = {
	id: 'badges',
	gate: 'G1',
	kind: 'baseline',
	defaultEnabled: true,
	note: 'Badge-family detection (aspect/dark-interior/size gates) plus dark-plate glyph recovery.',
	knobs: {
		badgeAspectMin: {
			default: 1.15,
			note: 'minimum aspect ratio for bright badge candidates (was BADGE_ASPECT_MIN)'
		},
		badgeAspectMax: {
			default: 1.8,
			note: 'maximum aspect ratio for bright badge candidates (was BADGE_ASPECT_MAX)'
		},
		badgeDarkInteriorMin: {
			default: 0.45,
			note: 'minimum dark pixel fraction for badge interior (was BADGE_DARK_INTERIOR_MIN)'
		},
		badgeSizeTolFactor: {
			default: 1.15,
			note: 'size tolerance for badge family clustering, in linear space; Math.log(...) is applied at the anchoredFamilies use site (was BADGE_SIZE_TOL = Math.log(1.15), per merge note 4)'
		},
		plateMinWidth: {
			default: 34,
			note: 'minimum width for dark-plate badge recovery candidates'
		},
		plateMaxWidth: {
			default: 78,
			note: 'maximum width for dark-plate badge recovery candidates'
		},
		plateMinHeight: {
			default: 24,
			note: 'minimum height for dark-plate badge recovery candidates'
		},
		plateMaxHeight: {
			default: 54,
			note: 'maximum height for dark-plate badge recovery candidates'
		},
		plateAspectMin: {
			default: 1,
			note: 'minimum aspect ratio for dark-plate candidates'
		},
		plateAspectMax: {
			default: 2.4,
			note: 'maximum aspect ratio for dark-plate candidates'
		},
		plateFillMin: {
			default: 0.55,
			note: 'minimum fill fraction (area/bbox) for dark-plate candidates'
		},
		plateInteriorMargin: {
			default: 4,
			note: 'pixel margin for interior glyph fraction measurement (coincidentally also 4, but a distinct knob from plateBboxMargin)'
		},
		plateGlyphFractionMin: {
			default: 0.04,
			note: 'minimum bright pixel fraction in plate interior'
		},
		plateGlyphFractionMax: {
			default: 0.4,
			note: 'maximum bright pixel fraction in plate interior'
		},
		plateProximityThreshold: {
			default: 22,
			note: 'distance threshold: a dark-plate candidate must not be near an already-accepted bright badge'
		},
		plateBboxMargin: {
			default: 4,
			note: 'margin for expanding the dark-plate badge bounding box (coincidentally also 4, but a distinct knob from plateInteriorMargin)'
		},
		badgeInsidePadding: {
			default: 3,
			note: 'padding (px) around a badge bbox for the tee-candidate exclusion test in measure.ts makeTees; the rejection reason string is templated from this value (was hard-coded "+3px pad" — see file header)'
		}
	}
} satisfies ABFeature;
