/**
 * Shared data/flow logic for importing a pending stitched-image handoff
 * (`session.ts`'s `PendingHandoff`) into a `ProjectEditor`, factored out of
 * annotate-round and create-graphics' near-identical `handleHandoffImport`
 * handlers (the annotate-round copy used to note the duplication explicitly).
 *
 * Both routes route the handoff through the exact same intake/replacement
 * path as a pane file upload (`intakeImageFile`), so point-discard
 * confirmation, asset manifest creation, undo/redo, and dirty state all
 * apply identically. What differs between the two call sites — which role
 * the image is assigned to, how discard is confirmed, and what happens to
 * route-local banner/state after each outcome — stays with the caller; this
 * helper only builds the `File`, drives `intakeImageFile`, and classifies
 * the result so each route can apply its own side effects and copy.
 */
import type { ProjectEditor } from './domain/editor';
import type { ImageRole } from './domain/project';
import type { DecodeImageFile } from './imageIntake';
import { intakeImageFile } from './imageIntake';
import type { PendingHandoff } from './session';

export interface ImportHandoffImageOptions {
	editor: ProjectEditor;
	handoff: PendingHandoff;
	/** The role to assign the imported image to (not always `handoff.targetRole` verbatim — annotate-round always imports as `source-overview`, the only role it ever shows a handoff banner for). */
	role: ImageRole;
	decode?: DecodeImageFile;
	confirmDiscard: (affectedPairCount: number) => boolean | Promise<boolean>;
}

export type ImportHandoffImageResult =
	| { status: 'imported' }
	| { status: 'cancelled' }
	| { status: 'error'; message: string };

/**
 * Builds a `File` from the pending handoff's blob/fileName and imports it via
 * `intakeImageFile`. Returns a classified outcome instead of mutating
 * anything itself — the caller decides what "imported" means for its own
 * `$state` (consuming the pending slot, clearing its banner, refreshing,
 * setting an activity message, and so on).
 */
export async function importHandoffImage(
	options: ImportHandoffImageOptions
): Promise<ImportHandoffImageResult> {
	const { editor, handoff, role, decode, confirmDiscard } = options;
	try {
		const file = new File([handoff.blob], handoff.fileName, { type: 'image/png' });
		const result = await intakeImageFile({ editor, role, file, decode, confirmDiscard });
		if (!result.ok) return { status: 'error', message: result.error.message };
		if (result.status === 'cancelled') return { status: 'cancelled' };
		return { status: 'imported' };
	} catch (error) {
		return {
			status: 'error',
			message: error instanceof Error ? error.message : 'Could not import the stitched image.'
		};
	}
}
