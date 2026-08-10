/**
 * ChainSpot guided demo catalog (`/demo`).
 *
 * The demo is a *narration layer*, never a second implementation of the
 * product: every step sends a prospective customer into a real route
 * (`/stitch-map`, `/annotate-round`, `/create-graphics`) holding real inputs,
 * and the work is done by the same code a paying user runs. This module owns
 * only the two things that are genuinely demo-specific — which real assets the
 * walkthrough hands over, and what the visitor is told at each stop.
 *
 * Two rules keep the demo honest, and both are load-bearing:
 *
 * 1. **No synthetic inputs.** The dataset is four real UDisc screenshots of a
 *    real 18-hole course (see `static/resources/demo/bill-allen/README.md`).
 *    The capture files carry no grid position in their names and are not in
 *    reading order, so Smart Import's inferred arrangement is a real inference
 *    from image content, not a filename lookup.
 * 2. **No mocked services.** The clean basemap is not shipped as a fixture. The
 *    Create Graphics step sends the visitor through the live OpenStreetMap
 *    Nominatim search and the live USGS NAIP `exportImage` endpoint that the
 *    product already uses, with a real course name as the query.
 *
 * Adding a dataset is a data change here; it must never require a new branch in
 * a route.
 */
import { base } from '$app/paths';

/** One real file the walkthrough can hand to a real intake path. */
export interface DemoAsset {
	/** Path under `static/`, without the deployment base path. */
	readonly path: string;
	/** File name presented to intake, exactly as a user's own file would be. */
	readonly fileName: string;
	/** MIME type presented to intake; must be one of `SUPPORTED_MIME_TYPES`. */
	readonly mimeType: string;
}

/** A real course whose captures drive one complete walkthrough. */
export interface DemoDataset {
	readonly id: string;
	/** Course name, written the way a user would type it into course search. */
	readonly courseName: string;
	/** City and state, matching the Create Graphics geocode field. */
	readonly cityState: string;
	/** How many holes the captures actually contain. */
	readonly holeCount: number;
	/** The four unordered 2×2 captures handed to Smart Import. */
	readonly captures: readonly DemoAsset[];
	/** Whole-course lower-zoom screenshot, shown on `/demo` as context only. */
	readonly overview: DemoAsset;
}

/** Which real route a step is performed on. */
export type DemoRoute = 'stitch-map' | 'annotate-round' | 'create-graphics';

/**
 * What a step can load on the visitor's behalf. Arming is always an
 * accelerator, never the only path: every armed input is something the visitor
 * could equally have supplied through the route's own file picker, and the
 * natural route-to-route path (Stitch Map's "Use as UDisc source", Annotate
 * Round's "Done") is always still available.
 *
 * - `stitch-captures` drops the four captures into Stitch Map's Smart Import,
 *   the same entry point its "Import four screenshots" control uses.
 * - `annotate-source` publishes a real UDisc capture through the product's
 *   existing pending-handoff store, so Annotate Round shows its ordinary import
 *   banner and applies its ordinary replacement rules. This is the fallback for
 *   a visitor who jumps straight to step 2; arriving from step 1 by way of "Use
 *   as UDisc source" hands over the visitor's own stitch instead, and the
 *   product never silently overwrites a handoff that is already pending.
 * - `none` means the step's input is the visitor's own typing (course search)
 *   or the artifact the previous step produced.
 */
export type DemoArming =
	| { readonly kind: 'stitch-captures' }
	| { readonly kind: 'annotate-source' }
	| { readonly kind: 'none' };

export interface DemoStep {
	readonly id: string;
	readonly title: string;
	readonly route: DemoRoute;
	/** One sentence naming what the visitor is looking at. */
	readonly lede: string;
	/** Concrete things to do, in the real UI, in order. */
	readonly actions: readonly string[];
	/** What is actually happening underneath — the credibility line. */
	readonly mechanism: string;
	readonly arming: DemoArming;
}

const BILL_ALLEN_DIR = '/resources/demo/bill-allen';

export const BILL_ALLEN: DemoDataset = {
	id: 'bill-allen',
	courseName: 'Bill Allen Memorial Park Disc Golf Course',
	cityState: 'Frisco, TX',
	holeCount: 18,
	captures: [
		{
			path: `${BILL_ALLEN_DIR}/udisc-capture-1.png`,
			fileName: 'udisc-capture-1.png',
			mimeType: 'image/png'
		},
		{
			path: `${BILL_ALLEN_DIR}/udisc-capture-2.png`,
			fileName: 'udisc-capture-2.png',
			mimeType: 'image/png'
		},
		{
			path: `${BILL_ALLEN_DIR}/udisc-capture-3.png`,
			fileName: 'udisc-capture-3.png',
			mimeType: 'image/png'
		},
		{
			path: `${BILL_ALLEN_DIR}/udisc-capture-4.png`,
			fileName: 'udisc-capture-4.png',
			mimeType: 'image/png'
		}
	],
	overview: {
		path: `${BILL_ALLEN_DIR}/udisc-course-overview.jpg`,
		fileName: 'udisc-course-overview.jpg',
		mimeType: 'image/jpeg'
	}
};

export const DEMO_DATASET: DemoDataset = BILL_ALLEN;

/**
 * The walkthrough script. Ordering mirrors the product's own pipeline —
 * capture, stitch, annotate, acquire a clean basemap, align, export — because
 * the demo's whole argument is that the pipeline is the product.
 */
export const DEMO_STEPS: readonly DemoStep[] = [
	{
		id: 'stitch',
		title: 'Turn four phone screenshots into one high-detail map',
		route: 'stitch-map',
		lede: `Four real UDisc screenshots of ${BILL_ALLEN.courseName} are loaded into the real Stitch Map, in no particular order and with no position in their file names.`,
		actions: [
			'Read the status line: it names which capture landed in which corner and how confident the inference was.',
			'Check the proposed crop — the phone status bar and UDisc chrome are trimmed from all four captures at once.',
			'Nudge a tile with the arrow keys, or press Snap, to see that every automatic decision is reported with its confidence and stays fully correctable.',
			'When the arrangement reads as connected, choose "Use as UDisc source" to carry the stitched PNG forward.'
		],
		mechanism:
			'Position, overlap, and crop are inferred from pixel content in a Web Worker using OpenCV template matching. The export is a native-resolution PNG of the union of the four cropped tiles — no resampling, no upload.',
		arming: { kind: 'stitch-captures' }
	},
	{
		id: 'annotate',
		title: 'Watch ChainSpot find the course, then fix the one hole it missed',
		route: 'annotate-round',
		lede: 'The map you just stitched arrives through the product\'s ordinary handoff banner — the same banner a user sees. Skipped step 1? Loading the sample here hands over the whole-course capture instead. What happens next is not a canned animation: watch ChainSpot actually go looking for the course.',
		actions: [
			'Watch the status strip narrate detection as it runs — reading hole numbers, finding tee pads, locating baskets, assembling the course — with each stage\'s proposals fading onto the map in that same order as it finishes.',
			'When the summary chip lands, accept the ready holes in one click — the holes detection is confident about are placed immediately, with the count right there in the chip.',
			'Jump to the hole still flagged for review and fix it yourself: click the detected tee or basket candidate underneath it and it snaps onto the active hole instantly — no dialog, one click.',
			'Press Done to package the round and continue to Create Graphics.'
		],
		mechanism:
			'Detection is calibrated OpenCV template matching running locally in your browser, and the status strip and staged reveal report its real stage boundaries as they happen — nothing is simulated for effect. It is honestly imperfect where holes overlap or crowd each other on the map, which is an area of active research, and that is exactly why the review step and the one-click fix exist rather than a silent best guess. The annotated round crosses to the next stage in memory; nothing is uploaded and nothing is written to disk unless you save a bundle yourself.',
		arming: { kind: 'annotate-source' }
	},
	{
		id: 'basemap',
		title: 'Pull a clean aerial basemap from live public imagery',
		route: 'create-graphics',
		lede: 'Create Graphics needs a clean basemap with no UDisc overlay on it. This step fetches one from public imagery, live, right now.',
		actions: [
			`Search for "${BILL_ALLEN.courseName}" in "${BILL_ALLEN.cityState}" — or type your own course instead.`,
			'Pick the match, set a radius that covers the whole property, and fetch the aerial.',
			'Keep the single tile, or fetch the higher-resolution grid mosaic if the course is large.'
		],
		mechanism:
			'Course search is the public OpenStreetMap Nominatim endpoint; the imagery is the public USGS NAIP exportImage service. Both are called straight from your browser with no API key and no ChainSpot server in the middle — there is no backend to send your data to.',
		arming: { kind: 'none' }
	},
	{
		id: 'align',
		title: 'Align the round to the basemap',
		route: 'create-graphics',
		lede: 'Two images, one course. Correspondences tie the annotated UDisc map to the clean aerial.',
		actions: [
			'Use Add correspondence to click the same landmark in both panes — a tee pad corner, a path junction, a tree.',
			'Spread four or more pairs across the whole property and watch the readiness and residual diagnostics respond.',
			'Drag a marker slightly off and watch its residual climb, so you can see exactly which pair is hurting the fit.'
		],
		mechanism:
			'A similarity or affine transform is estimated from your pairs, with per-pair residuals reported in original pixels. Original-pixel coordinates are authoritative throughout; normalized values are derived for display only.',
		arming: { kind: 'none' }
	},
	{
		id: 'export',
		title: 'Take the broadcast-ready graphics',
		route: 'create-graphics',
		lede: 'The point of all of it: per-hole graphics on a clean basemap, reusable for every round played on this course.',
		actions: [
			'Step through the holes and review each rendered graphic against the aerial.',
			'Save the project bundle — a portable zip holding the project plus your original images, byte for byte.',
			'Reopen the bundle to confirm it round-trips exactly, then keep using the app with your own course.'
		],
		mechanism:
			'The bundle is a plain zip containing project.json and the untouched originals, with SHA-256 hashes that must match on open. Your work is a file you own, not a row in someone else\'s database.',
		arming: { kind: 'none' }
	}
];

export const DEMO_STEP_COUNT = DEMO_STEPS.length;

/** Resolves a demo asset to a fetchable URL under the deployment base path. */
export function demoAssetUrl(asset: DemoAsset): string {
	return `${base}${asset.path}`;
}

/** The route path a step is performed on, under the deployment base path. */
export function demoStepUrl(step: DemoStep): string {
	return `${base}/${step.route}`;
}

/** Human label for a route, matching the header navigation wording. */
export function demoRouteLabel(route: DemoRoute): string {
	switch (route) {
		case 'stitch-map':
			return 'Stitch Map';
		case 'annotate-round':
			return 'Annotate Round';
		case 'create-graphics':
			return 'Create Graphics';
	}
}
