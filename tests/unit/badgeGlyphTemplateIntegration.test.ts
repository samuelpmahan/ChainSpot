// Integration test for the badgeGlyphTemplate ABFeature (docs/CLAIMS-LEDGER.md
// row 23) over a real Dev6 course: with the feature ON, the whole-glyph
// template classifier's reads must agree with the current per-digit reader
// on every badge, now that the G1 OCR fix contract has landed (the ledger's
// disagreements were all pre-fix garbage reads). Any real disagreement here
// is reported as a finding (badge id + both readings), never fudged.

import { describe, expect, test } from 'vitest';
import {
	DEFAULT_EXECUTION,
	parseConfig,
	resolveConfig,
	runThreeFactor,
	type ThreeFactorConfig
} from '@chainspot/alg/detectors/threeFactor';
import { compileExecutionPlan } from '@chainspot/alg/exec';
import defaultConfigJson from '@chainspot/alg/detectors/threeFactor/configs/default.json';
import badgeGlyphTemplateOnJson from '@chainspot/alg/detectors/threeFactor/configs/badge-glyph-template-on.json';
import { buildBadgeGlyphTemplateReceipt } from '../../packages/alg/src/detectors/threeFactor/features/g1.badgeGlyphTemplateReceipt';
import { loadDashsTrackRaster } from './helpers/dashsTrackFixture';

describe('badgeGlyphTemplate production integration', () => {
	test('default config omits the operation entirely -- zero behavior change while OFF', () => {
		const resolved = resolveConfig(defaultConfigJson as ThreeFactorConfig, DEFAULT_EXECUTION);
		const plan = compileExecutionPlan(resolved);
		expect(resolved.features.badgeGlyphTemplate).toBeUndefined();
		expect(plan.ops.map((op) => op.id)).not.toContain('badgeGlyphTemplate');
	});

	test(
		'badge-glyph-template-on.json: template reads agree with the current reader on every DashsTrack badge',
		() => {
			const raster = loadDashsTrackRaster();
			const resolved = resolveConfig(parseConfig(badgeGlyphTemplateOnJson), DEFAULT_EXECUTION);
			const plan = compileExecutionPlan(resolved);
			expect(plan.ops.map((op) => op.id)).toContain('badgeGlyphTemplate');

			const run = runThreeFactor(raster, {
				config: resolved,
				paramsHash: 'badge-glyph-template-dashstrack'
			});
			const unit = run.trace?.units.find((u) => u.id === 'badgeGlyphTemplate');
			expect(unit).toBeDefined();
			expect(unit?.enabled).toBe(true);

			const receipt = buildBadgeGlyphTemplateReceipt(unit!, run.trace!);
			console.log('[badgeGlyphTemplate/DashsTrack]\n' + receipt.cliText);

			// Every badge the current reader saw must have a corresponding row.
			expect(receipt.rows.length).toBe(run.measurement.badges.length);

			// The headline claim: post-OCR-fix, the two mechanisms agree on every
			// badge on this course. A real disagreement is reported here as a
			// finding (not hidden) via the failure message, never adjusted away.
			if (receipt.disagreementRows.length > 0) {
				const detail = receipt.disagreementRows
					.map(
						(row) =>
							`badge ${row.badgeId}: current reader=${row.currentLabel}, ` +
							`template=${row.templateLabel} (score=${row.templateScore}, margin=${row.templateMargin})`
					)
					.join('\n');
				throw new Error(
					`FINDING: ${receipt.disagreementRows.length} disagreement(s) between the current reader ` +
						`and the whole-glyph template classifier on DashsTrack:\n${detail}`
				);
			}
			expect(receipt.disagreementRows.length).toBe(0);
		},
		30000
	);
});
