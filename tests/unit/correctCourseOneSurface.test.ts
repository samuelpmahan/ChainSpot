import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Correct Course adds no image-interaction implementation of its own: every pointer gesture goes through
 * ImageEditorPane -> ImageViewport's claim protocol. Guard the files it added.
 */
const FILES = [
	'src/routes/correct-course/+page.svelte',
	'src/lib/components/CourseCorrectionLayer.svelte',
	'src/lib/courseCorrection.ts'
];
const FORBIDDEN = [/addEventListener\(\s*['"](pointer|mouse|touch|wheel)/, /setPointerCapture/, /from ['"]konva['"]/, /on(pointer|mouse)(down|move|up)=/, /ondblclick=/, /onwheel=/];

describe('Correct Course uses the one image surface', () => {
	for (const file of FILES) {
		it(`${file} has no pointer, wheel or Konva handling of its own`, () => {
			const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
			for (const pattern of FORBIDDEN) expect(text, String(pattern)).not.toMatch(pattern);
		});
	}
});
