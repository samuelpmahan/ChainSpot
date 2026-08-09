import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
	asTemplateScale,
	asUiScalePx,
	deriveUDiscCalibration,
	validateCvTemplateManifest
} from '../../src/lib/autoAnnotation/cvCalibration';
import type { TemplateScale, UiScalePx } from '../../src/lib/autoAnnotation/cvCalibration';
import type { CalibratedTeePadDetectionOptions } from '../../src/lib/autoAnnotation/cvCalibratedDetectors';
import type {
	CourseDetectionResult,
	UiScaleInput
} from '../../src/lib/autoAnnotation/basketDetection';
import { loadValidatedCvTemplateManifest } from '../../scripts/cv-template-manifest';

const holeNumbers = Array.from({ length: 18 }, (_, index) => `hole-${String(index + 1).padStart(2, '0')}.png`);

function manifest(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		calibration: { canonicalNumberBadge: { widthPx: 30, heightPx: 23 } },
		templates: { holeNumbers, basket: 'basket.png' },
		...overrides
	};
}

describe('CV calibration semantics', () => {
	it('derives canonical UDisc UI scale from matched badge dimensions, not template scale', () => {
		const first = deriveUDiscCalibration({
			scale: asTemplateScale(1),
			widthPx: 53,
			heightPx: 41
		});
		const second = deriveUDiscCalibration({
			scale: asTemplateScale(4.25),
			widthPx: 53,
			heightPx: 41
		});

		expect(first.uiScalePx).toBeCloseTo(1.7746376811594202, 8);
		expect(second.uiScalePx).toBe(first.uiScalePx);
		expect(first.anchor.templateScale).toBe(1);
		expect(second.anchor.templateScale).toBe(4.25);
	});

	it('keeps TemplateScale and UiScalePx non-interchangeable at typed detector boundaries', () => {
		const templateScale = asTemplateScale(1);
		const uiScalePx = asUiScalePx(1.7746);
		const acceptsUiScale = (_value: UiScalePx): void => {};
		acceptsUiScale(uiScalePx);

		// @ts-expect-error TemplateScale is not canonical UDisc UiScalePx.
		acceptsUiScale(templateScale);

		const validOptions: Pick<CalibratedTeePadDetectionOptions, 'uiScalePx'> = { uiScalePx };
		expect(validOptions.uiScalePx).toBe(uiScalePx);

		// @ts-expect-error A raw template multiplier cannot reach calibrated tee geometry.
		const invalidOptions: Pick<CalibratedTeePadDetectionOptions, 'uiScalePx'> = { uiScalePx: templateScale };
		void invalidOptions;

		const publicInput: UiScaleInput = uiScalePx;
		expect(publicInput).toBe(uiScalePx);
		// @ts-expect-error The browser tee boundary rejects branded TemplateScale too.
		const invalidPublicInput: UiScaleInput = templateScale;
		void invalidPublicInput;
	});

	it('brands the public number-detection anchor as TemplateScale', () => {
		const compileOnly = (course: CourseDetectionResult): void => {
			const anchor = course.numberDetection.anchor;
			if (!anchor) return;
			const templateScale: TemplateScale = anchor.scale;
			void templateScale;
			// @ts-expect-error Public number anchor scale must not be usable as UiScalePx.
			const uiScalePx: UiScalePx = anchor.scale;
			void uiScalePx;
		};
		expect(typeof compileOnly).toBe('function');
	});

	it('keeps semantic metadata independent from arbitrary native PNG crop dimensions', () => {
		const parsed = validateCvTemplateManifest({
			...manifest(),
			// Deliberately irrelevant metadata: native crops may all differ.
			nativeCropDimensions: {
				'hole-01.png': [53, 41],
				'hole-02.png': [52, 40],
				'hole-10.png': [55, 40]
			}
		});
		expect(parsed.calibration.canonicalNumberBadge).toEqual({ widthPx: 30, heightPx: 23 });
		expect(parsed.templates.holeNumbers).toHaveLength(18);
	});

	it('fails clearly for invalid or mismatched calibration metadata', () => {
		expect(() =>
			validateCvTemplateManifest({
				...manifest(),
				calibration: { canonicalNumberBadge: { widthPx: 0, heightPx: 23 } }
			})
		).toThrow(/positive finite/);
		expect(() => validateCvTemplateManifest({ schemaVersion: 1, templates: manifest().templates })).toThrow(/calibration/);
		expect(() =>
			deriveUDiscCalibration(
				{ scale: asTemplateScale(1), widthPx: 53, heightPx: 41 },
				{ widthPx: 31, heightPx: 23 }
			)
		).toThrow(/does not match the compiled canonical badge geometry/);
	});
});

describe('CV template manifest asset guardrail', () => {
	it('fails when a manifest asset is missing and accepts differing native file contents', () => {
		const root = mkdtempSync(join(tmpdir(), 'chainspot-cv-manifest-'));
		try {
			writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest()));
			for (const fileName of holeNumbers) writeFileSync(join(root, fileName), fileName.repeat((fileName.length % 3) + 1));
			expect(() => loadValidatedCvTemplateManifest(root)).toThrow(/basket\.png/);
			writeFileSync(join(root, 'basket.png'), 'different native raster payload');
			const parsed = loadValidatedCvTemplateManifest(root);
			expect(parsed.calibration.canonicalNumberBadge).toEqual({ widthPx: 30, heightPx: 23 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe('tee calibration handoff audit', () => {
	it('keeps every active tee entry path behind a calibration helper/boundary', async () => {
		const { readFileSync } = await import('node:fs');
		const worker = readFileSync('src/lib/autoAnnotation/basketDetection.worker.ts', 'utf8');
		const cli = readFileSync('scripts/detect-tees.ts', 'utf8');
		const browser = readFileSync('src/routes/annotate-round/+page.svelte', 'utf8');
		expect(worker).toContain('deriveUDiscCalibration(');
		expect(worker).not.toContain('median(baskets.map((candidate) => candidate.scale))');
		expect(cli).toContain('deriveUDiscCalibration(');
		// Browser experiment calls the same sole 30×23 formula primitive; the
		// public detectTees boundary immediately brands/validates that number.
		expect(browser).toContain('deriveTeePadUiScalePx(');
		expect(browser).not.toContain('uiScalePx: courseDetection?.numberDetection?.anchor?.scale');
	});
});
