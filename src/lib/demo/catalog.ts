/**
 * ChainSpot guided demo catalog (`/demo`).
 *
 * The demo is a *narration layer* over the real product, never a second
 * implementation of it: every step sends a prospective customer into a real
 * route (`/stitch-map`, `/annotate-course`, `/map-round`, `/create-graphics`)
 * holding real inputs, and the work is done by the same code a paying user
 * runs. This module owns only the two things that are genuinely demo-specific
 * — which real assets the walkthrough hands over, and what the visitor is
 * told at each stop.
 *
 * The script tells the product's whole story, not just half of it: build the
 * map once (steps 1–2), pull a clean basemap and export graphics from it
 * (step 3), then prove the map is reusable by reloading the browser — losing
 * every in-session artifact — and annotating a *played round* of the same
 * course entirely from what Course Memory remembered (steps 4–6).
 *
 * Two rules keep the demo honest, and both are load-bearing:
 *
 * 1. **No synthetic inputs.** The map-creation dataset is four real UDisc
 *    screenshots of a real 18-hole course (see
 *    `static/resources/demo/dashs-track/README.md`). The capture files carry
 *    no grid position in their names and are not in reading order, so Smart
 *    Import's inferred arrangement is a real inference from image content,
 *    not a filename lookup. The round-annotation input is a second, real
 *    capture of the same course, already played — the blue landing droplets
 *    and purple walking path the visitor annotates over are pixels in the
 *    image, not something the demo drew. That capture is handed to Map Round
 *    exactly as taken, phone chrome included; nothing crops it, and the
 *    narration says so rather than pretending it isn't there.
 * 2. **No mocked services.** The clean basemap is not shipped as a fixture,
 *    in either Create Graphics step. Both send the visitor through the live
 *    course search and public aerial imagery endpoint that the product already
 *    uses, with a real course name as the query.
 *
 * Adding a dataset is a data change here; it must never require a new branch
 * in a route.
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
	/** The four unordered 2×2 captures handed to Smart Import in step 1. */
	readonly captures: readonly DemoAsset[];
	/**
	 * A single screenshot of a *played* round of the same course — blue
	 * landing droplets and a purple walking path already in the pixels —
	 * handed to Map Round in step 5 through the same pending-handoff
	 * path the stitched export uses in step 2. Unlike `captures`, this one is
	 * not run through any crop step: it arrives with full phone chrome
	 * (status bar, course title bar, hole/par banner, bottom nav) exactly as
	 * captured. An interim stand-in the user has said will be replaced with a
	 * cleaner capture; swapping it is meant to be exactly this one field plus
	 * a file under `static/`, nothing else.
	 */
	readonly roundOverview: DemoAsset;
}

/** Which real route a step is performed on. */
export type DemoRoute = 'stitch-map' | 'annotate-course' | 'map-round' | 'create-graphics';

/**
 * Almost every step is `'default'`: the guide's Next button either stays put
 * or performs an ordinary client-side `goto` to the next step's route, exactly
 * like SvelteKit's own navigation. `'reload'` marks the one step whose Next
 * must instead be a *real* browser reload — see `demo-walkthrough.md`'s
 * "Reload" step — because the narration's claim ("everything in-session is
 * gone, but the course is remembered") is only true of an actual reload; a
 * SPA `goto` would leave retained editor state sitting in `session.ts`
 * untouched and the claim would be false. `DemoGuide` is the only consumer of
 * this field.
 */
export type DemoStepKind = 'default' | 'reload';

/**
 * What a step can load on the visitor's behalf. Arming is always an
 * accelerator, never the only path: every armed input is something the visitor
 * could equally have supplied through the route's own file picker, and the
 * natural route-to-route path (Stitch Map's "Use as UDisc source", either
 * annotation route's "Done") is always still available.
 *
 * - `stitch-captures` drops the four captures into Stitch Map's Smart Import,
 *   the same entry point its "Import four screenshots" control uses.
 * - `annotate-source` publishes `DEMO_DATASET.roundOverview` through the
 *   product's existing pending-handoff store (destined for `/map-round`), so
 *   Map Round shows its ordinary import banner and applies its ordinary
 *   replacement rules.
 * - `none` means the step's input is the visitor's own typing (course search),
 *   the artifact the previous step produced, or — for the Annotate Course
 *   step — the product's own "Use as UDisc source" handoff from step 1, which
 *   needs no demo-side arming at all.
 */
export type DemoArming =
	| { readonly kind: 'stitch-captures' }
	| { readonly kind: 'annotate-source' }
	| { readonly kind: 'none' };

/**
 * The Spotlight presentation's anchor contract (CHSPT-73).
 *
 * A semantic name for one real product control or region a step asks the
 * visitor to use. Product markup opts in by carrying
 * `data-demo-anchor="<id>"` on the element; a step references the id via its
 * `spotlight` field. The guide never holds route-specific DOM selectors —
 * this union is the entire vocabulary, and both sides (the product attribute
 * and the step metadata) must speak it.
 *
 * Anchors are best-effort by design: a target that is absent, hidden, or not
 * yet rendered (the stitch alignment HUD only exists once a result is up)
 * simply means the Spotlight guide renders without a ring. Nothing may ever
 * gate on an anchor resolving.
 */
export type DemoAnchorId =
	| 'stitch-alignment-review'
	| 'annotation-done'
	| 'map-round-import'
	| 'graphics-location-search';

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
	/** Defaults to `'default'` when absent — see `DemoStepKind`. */
	readonly kind?: DemoStepKind;
	/**
	 * The real product control this step spotlights, when one control is the
	 * step's clear next move. Absent when the step's work is spread across the
	 * surface (the reload step's own CTA lives in the guide) — see
	 * `DemoAnchorId` for the fallback contract.
	 */
	readonly spotlight?: DemoAnchorId;
}

const DASHS_TRACK_DIR = '/resources/demo/dashs-track';

export const DASHS_TRACK: DemoDataset = {
	id: 'dashs-track',
	courseName: "Dash's Track",
	cityState: 'Frisco, TX',
	holeCount: 18,
	captures: [
		{
			path: `${DASHS_TRACK_DIR}/udisc-capture-1.png`,
			fileName: 'udisc-capture-1.png',
			mimeType: 'image/png'
		},
		{
			path: `${DASHS_TRACK_DIR}/udisc-capture-2.png`,
			fileName: 'udisc-capture-2.png',
			mimeType: 'image/png'
		},
		{
			path: `${DASHS_TRACK_DIR}/udisc-capture-3.png`,
			fileName: 'udisc-capture-3.png',
			mimeType: 'image/png'
		},
		{
			path: `${DASHS_TRACK_DIR}/udisc-capture-4.png`,
			fileName: 'udisc-capture-4.png',
			mimeType: 'image/png'
		}
	],
	roundOverview: {
		path: `${DASHS_TRACK_DIR}/udisc-round-overview.png`,
		fileName: 'udisc-round-overview.png',
		mimeType: 'image/png'
	}
};

export const DEMO_DATASET: DemoDataset = DASHS_TRACK;

/**
 * The walkthrough script. Ordering mirrors the product's own story: build the
 * map once (1–2), get one course onto air (3), then prove the map pays off by
 * losing the session and re-using it for a played round (4–6) — because the
 * whole pitch is that hole 1's graphic on Tuesday and hole 1's graphic on
 * Saturday come from the same map without redoing the work.
 */
export const DEMO_STEPS: readonly DemoStep[] = [
	{
		id: 'stitch',
		title: 'Turn four phone screenshots into one high-detail map',
		route: 'stitch-map',
		lede: `Four real UDisc screenshots of ${DASHS_TRACK.courseName}, phone chrome and all, are loaded into the real Stitch Map in no particular order and with no position in their file names.`,
		actions: [
			'Watch the four captures crop, arrange, and stitch themselves automatically — no crop approval or "assemble" click required.',
			'Read the status line: it names how many captures were stitched and how confident the automatic result was.',
			'If a result ever needs a closer look, click "Adjust manually" to nudge a tile with the arrow keys or press Snap — every automatic decision stays fully correctable, it just no longer blocks you by default.',
			'When the result looks right, choose "Continue to Annotate Course" to carry the stitched map forward.'
		],
		mechanism:
			'Chrome cropping, position, and overlap are all inferred from pixel content in a Web Worker using OpenCV template matching — nothing here is a filename lookup. The export is a native-resolution PNG of the union of the four cropped tiles, no resampling, no upload.',
		arming: { kind: 'stitch-captures' },
		spotlight: 'stitch-alignment-review'
	},
	{
		id: 'annotate-course',
		title: 'Review the course detection one uncertain piece at a time',
		route: 'annotate-course',
		lede: 'The map you just stitched arrives through the product\'s ordinary handoff banner — the same banner a user sees, using "Use as UDisc source" from the previous step. Annotate Course is course geometry, not any one round. Detection opens an active review with a live ready-versus-review split, not a promise that every hole is solved.',
		actions: [
			'Watch the status strip narrate detection as it runs — reading hole numbers, finding tee pads, locating baskets, assembling the course — with each stage\'s proposals fading onto the map in that same order as it finishes.',
			'Read the live summary chip. It reports the full detected set and separates ready holes from holes that still need review — the current demo may show a split such as "18 holes — 6 ready, 12 need review", rather than just one missed hole.',
			'Click "Review hole N" to jump to the first unresolved hole, then work one tee or basket at a time: inspect a candidate marker and click it to assign it to the active hole, confirming only when replacing or moving existing geometry.',
			'Accept the ready holes when you want to commit the confident subset; the remaining review holes stay visible and editable instead of being silently guessed.',
			'Add a corridor bend on a hole to see the playing corridor update live — Annotate Course only ever places tee, basket, and bend, never a throw; that is Map Round\'s job.',
			'Press Done to save the course to Course Memory and continue to Create Graphics.'
		],
		mechanism:
			'Detection is calibrated OpenCV template and centerline matching running locally in your browser, and the status strip and staged reveal report its real stage boundaries as they happen — nothing is simulated for effect. The active review is deliberately split: confident geometry can be accepted together, while uncertain holes remain available for one-marker-at-a-time correction where overlaps or crowded areas defeat a safe automatic guess. Done saves the course geometry to Course Memory (IndexedDB) and hands the annotated round to Create Graphics in memory — nothing is uploaded.',
		arming: { kind: 'none' },
		spotlight: 'annotation-done'
	},
	{
		id: 'basemap-and-export',
		title: 'Put the map on air',
		route: 'create-graphics',
		lede: 'Create Graphics needs a clean basemap with no UDisc overlay, aligned to what you just annotated, then exports per-hole graphics from the pair.',
		actions: [
			`Search "${DASHS_TRACK.cityState}" — "${DASHS_TRACK.courseName}" is UDisc's name for the course. Start with a 300m radius; you can adjust it after the first preview. Or type your own course instead and treat the query as a starting guess you can correct from the results list.`,
			'Pick the match, keep the initial 300m radius, and fetch the aerial from live public imagery.',
			'Use Add correspondence to click the same landmark in both panes — a tee pad corner, a path junction, a tree — spreading four or more pairs across the property.',
			'Step through the holes, review each rendered graphic against the aerial, then save the project bundle.'
		],
		mechanism:
			'Course search supplies a candidate place, and the aerial imagery is fetched live from the public imagery service straight from your browser with no ChainSpot server in the middle. A similarity or affine transform is estimated from your correspondence pairs, with per-pair residuals reported in original pixels. The exported bundle is a plain zip holding project.json and your original images, byte for byte, with SHA-256 hashes that must match on open.',
		arming: { kind: 'none' },
		spotlight: 'graphics-location-search'
	},
	{
		id: 'reload',
		title: 'Reload the browser — and see what survives',
		route: 'create-graphics',
		kind: 'reload',
		lede: "Everything you just built lives in this tab's memory, nothing more. Reload the page the way a visitor closing and reopening the browser would, and watch what's still here.",
		actions: [
			'Notice the basemap, the correspondences, and the exported graphics are all in this browser session only — nothing was ever sent anywhere.',
			'Click "Reload the page" below. This is a real browser reload, not a page transition — every in-memory editor is gone afterward.',
			`${DASHS_TRACK.courseName}'s course geometry is different: it was written to Course Memory (IndexedDB) the moment you pressed Done in step 2, and IndexedDB survives a reload.`
		],
		mechanism:
			"A full reload clears every module-level session slot this app keeps (`src/lib/session.ts`) and the guided tour's own in-memory position — by design, nothing here is meant to survive a reload except what's explicitly written to storage. Course Memory is the one thing that is: an IndexedDB record keyed to the course's geometry, written on Done, read back by course recognition on the next image you import.",
		arming: { kind: 'none' }
	},
	{
		id: 'map-round',
		title: 'Annotate a round actually played on that course',
		route: 'map-round',
		lede: `A second, real capture of ${DASHS_TRACK.courseName} — this one played, with UDisc's own blue landing droplets and purple walking path already in the screenshot. Unlike the map tiles in step 1, this capture is handed over exactly as taken, full phone chrome included — the status bar, the course title bar, the hole/par banner, the bottom nav. This is Map Round: one round's throws and path, not course geometry.`,
		actions: [
			'Import the incoming image from the handoff banner. Nothing crops it first, so the phone chrome around the map is part of what you are looking at — that is expected for this capture, not a defect.',
			'Watch for "Recognized course" — Course Memory found this course from the map you built earlier — and choose "Import saved holes" rather than re-annotating tee pads and baskets from scratch.',
			'With the course geometry in place, click each blue landing droplet already in the screenshot to place that throw as a shot.',
			'Select the walk tool and trace the purple walking path already drawn in the screenshot, vertex by vertex — the walking path needs no hole selected.',
			'Press Done to hand the round, throws and all, to Create Graphics.'
		],
		mechanism:
			"Course recognition matches this image's hole-badge and basket geometry against Course Memory's saved signature — a real geometric comparison, not a name lookup — and importing applies the saved tee/basket/bend positions without CV re-running on them. The droplets and path are pixels in the source image; you are annotating over what UDisc already drew, exactly as a real customer's played-round screenshot would look, chrome and all.",
		arming: { kind: 'annotate-source' },
		spotlight: 'map-round-import'
	},
	{
		id: 'export-round',
		title: 'Export graphics for the round you just played',
		route: 'create-graphics',
		lede: 'The point of all of it: the same course map, reused for a specific round, exported as per-hole graphics that now show the throws and the walking path.',
		actions: [
			'Import the annotated round — its per-hole graphics now render the throws and the purple walking path over the aerial, not just the corridor.',
			`The basemap is gone after the reload; search "${DASHS_TRACK.cityState}" again, pan/zoom to the course, and re-fetch it live, the same as step 3.`,
			'Step through the holes and review each rendered graphic — throws, walking path, and corridor together — against the aerial.',
			'Save the project bundle and reopen it to confirm it round-trips exactly.'
		],
		mechanism:
			'Nothing about the basemap fetch or correspondence estimate changed from step 3 — it is re-run live because nothing about a fresh page load is special-cased for the demo. The AnnotatedRound artifact now carries shots and a walking path alongside the course geometry, and the per-hole graphic renderer draws both.',
		arming: { kind: 'none' },
		spotlight: 'graphics-location-search'
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
		case 'annotate-course':
			return 'Annotate Course';
		case 'map-round':
			return 'Map Round';
		case 'create-graphics':
			return 'Create Graphics';
	}
}
