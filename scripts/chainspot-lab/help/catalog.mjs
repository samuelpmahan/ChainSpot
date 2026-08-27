// @ts-nocheck
/**
 * ChainSpot LAB's single, dependency-free help catalog.
 *
 * Execution parsers remain authoritative.  This catalog describes only the
 * supported public surface so the cold CLI, REPL completion, error guidance,
 * and browser workbench can tell the same truthful story.
 */

export const AVAILABILITY = Object.freeze({
  AVAILABLE: 'AVAILABLE',
  CLI_ONLY: 'CLI_ONLY',
  UI_ONLY: 'UI_ONLY',
  INTERNAL_API_ONLY: 'INTERNAL_API_ONLY',
  REGISTERED_NONEXECUTING: 'REGISTERED_NONEXECUTING',
  PARKED_UNREGISTERED: 'PARKED_UNREGISTERED'
});

export const AVAILABILITY_MEANING = Object.freeze({
  [AVAILABILITY.AVAILABLE]: 'Supported on this LAB surface.',
  [AVAILABILITY.CLI_ONLY]: 'Supported only from the LAB command line.',
  [AVAILABILITY.UI_ONLY]: 'Supported only in the local LAB workbench.',
  [AVAILABILITY.INTERNAL_API_ONLY]: 'Present in source/internal data but not exposed as a LAB command.',
  [AVAILABILITY.REGISTERED_NONEXECUTING]: 'Registered/config-addressable but not an EngineUnit and therefore does not execute.',
  [AVAILABILITY.PARKED_UNREGISTERED]: 'Parked source only; not registered and not available to configure or execute.'
});

const option = (name, summary, { value, defaultValue, appliesTo, constraints, availability = AVAILABILITY.AVAILABLE } = {}) => ({
  name, summary, value, default: defaultValue, appliesTo, constraints, availability
});

const record = (id, fields) => Object.freeze({
  id,
  aliases: [],
  kind: 'topic',
  availability: AVAILABILITY.AVAILABLE,
  forms: [],
  subtopics: [],
  options: [],
  examples: [],
  sideEffects: [],
  outputs: [],
  caveats: [],
  ...fields
});

const scopeViewOptions = [
  option('--context', 'Context source span in canonical px.', { value: 'N', defaultValue: '800', constraints: 'positive integer' }),
  option('--context-out', 'Context output size.', { value: 'N', defaultValue: '800', constraints: 'positive integer' }),
  option('--full-out', 'Full-view output box; aspect is preserved.', { value: 'N', defaultValue: '1200', constraints: 'positive integer' }),
  option('--local-extra-w', 'Total extra Local width.', { value: 'N', defaultValue: '100', constraints: 'non-negative integer' }),
  option('--local-extra-h', 'Total extra Local height.', { value: 'N', defaultValue: '100', constraints: 'non-negative integer' }),
  option('--local-out', 'Local output box.', { value: 'N', defaultValue: '640', constraints: 'positive integer' }),
  option('--fw', 'Forensic wide source span.', { value: 'N', defaultValue: '192', constraints: 'positive integer; --fw > --fm > --ft' }),
  option('--fm', 'Forensic mid source span.', { value: 'N', defaultValue: '96', constraints: 'positive integer; --fw > --fm > --ft' }),
  option('--ft', 'Forensic tight source span.', { value: 'N', defaultValue: '48', constraints: 'positive integer; --fw > --fm > --ft' }),
  option('--forensic-out', 'Forensic tile output size.', { value: 'N', defaultValue: '240', constraints: 'positive integer' }),
  option('--no-grid', 'Suppress the coordinate grid on non-forensic views.', { appliesTo: 'scope/search/traverse visual forms' })
];

const searchViewOptions = scopeViewOptions.map((entry) => ({ ...entry, appliesTo: 'visual Search forms' }));

/** All public records, including leaf forms and browser-only mode context. */
export const HELP_CATALOG = Object.freeze([
  record('setup', {
    kind: 'command', group: 'SETUP', title: 'SETUP — install LAB runtime dependencies', availability: AVAILABILITY.CLI_ONLY,
    summary: 'Install/build the private LAB package and local @chainspot/alg workspace.',
    forms: ['lab setup'], examples: ['lab setup'],
    sideEffects: ['Writes package dependencies and local build products.'],
    caveats: ['Help is cold-safe; setup itself is intentionally a write.']
  }),
  record('set', {
    kind: 'command', group: 'CONTEXT', title: 'SET — persisted LAB context', availability: AVAILABILITY.CLI_ONLY,
    summary: 'Select a course, set local paths/variables, and manage reusable presets.',
    forms: ['lab set', 'lab set COURSE', 'lab set course COURSE', 'lab set courses', 'lab set corpus PATH', 'lab set KEY VALUE', 'lab set unset KEY', 'lab set save NAME', 'lab set load NAME', 'lab set @NAME', 'lab set reset'],
    examples: ['lab set DT', 'lab set page scratch', 'lab set save dashs-learning'],
    sideEffects: ['Writes local LAB config and, for presets, local preset files.'],
    outputs: ['Current context, selected course, or known course manifests.'],
    caveats: ['Unique initials/prefixes are accepted only while unambiguous.']
  }),
  record('set/show', { parent: 'set', title: 'SET SHOW — current context', summary: 'Print persisted LAB context without changing it.', forms: ['lab set', 'lab set show'], availability: AVAILABILITY.CLI_ONLY, outputs: ['Selected course and local context summary.'] }),
  record('set/corpus', { parent: 'set', aliases: ['set/corpusroot'], title: 'SET CORPUS — corpus root', summary: 'Set the local ChainSpot corpus root.', forms: ['lab set corpus PATH', 'lab set corpusRoot PATH'], availability: AVAILABILITY.CLI_ONLY, sideEffects: ['Writes local LAB config.'] }),
  record('tutorial', {
    kind: 'command', group: 'LEARN', title: 'TUTORIAL — first visual loop', availability: AVAILABILITY.CLI_ONLY,
    summary: 'Print the dependency-free guided DashsTrack learning loop.',
    forms: ['lab tutorial'], examples: ['lab tutorial'],
    outputs: ['A non-executing sequence: set DT, blind scope h1, then optional truth-assisted scope.'],
    caveats: ['The tutorial documents truth assistance; it does not execute it.']
  }),
  record('ui', {
    kind: 'command', group: 'LOOK', title: 'UI — local LAB workbench', availability: AVAILABILITY.CLI_ONLY,
    summary: 'Open the local browser workbench over the same LAB operation modules as the CLI.',
    forms: ['lab ui [--port N] [--no-open]'],
    options: [
      option('--port', 'Bind localhost UI to a port.', { value: 'N', defaultValue: '4317', constraints: 'integer 1..65535' }),
      option('--no-open', 'Start the server without launching a browser.')
    ],
    examples: ['lab ui', 'lab ui --port 4318 --no-open'],
    sideEffects: ['Starts a localhost-only server; UI actions may write their documented artifacts/state.'],
    caveats: ['The workbench has Scope, Search, Traverse, and full-plan Sweep. It has no UI --through control.'],
    subtopics: ['ui/scope', 'ui/search', 'ui/traverse', 'ui/sweep']
  }),
  record('scope', {
    kind: 'command', group: 'LOOK', title: 'SCOPE — stateless canonical raster inspection',
    summary: 'Inspect a post-Sweep canonical raster without running detector plans.',
    forms: ['lab scope hN [--truth] [view flags]', 'lab scope IMAGE x,y [view flags]', 'lab scope IMAGE x,y,w,h [view flags]'],
    options: [
      option('--truth', 'Explicitly use Annotation geometry.', { appliesTo: 'configured hN only', constraints: 'logs TRUTH-TAINT and is forbidden in blind/test runs' }),
      option('--out', 'Write one rendered artifact to this path.', { value: 'FILE', appliesTo: 'single rendered Scope forms' }),
      option('--name', 'Name a point/box request.', { value: 'NAME', appliesTo: 'point/box form' }),
      option('--template', 'Choose a Scope template.', { value: 'NAME', appliesTo: 'point/box form' }),
      option('--color', 'Set overlay color.', { value: 'N', appliesTo: 'mark/dots/path', constraints: 'numeric' }),
      option('--hole', 'Use Annotation geometry for a direct hole render.', { value: 'N', appliesTo: 'direct-hole form', constraints: 'positive integer' }),
      option('--manifest', 'Render cases from a Scope manifest.', { value: 'FILE', appliesTo: 'manifest form' }),
      option('--case', 'Select one manifest case.', { value: 'NAME', appliesTo: 'manifest/contact-sheet forms' }),
      option('--out-dir', 'Write manifest renders under this directory.', { value: 'DIR', appliesTo: 'manifest form' }),
      ...scopeViewOptions
    ],
    examples: ['lab scope h1', 'lab scope h1 --truth', 'lab scope course.png 880,429', 'lab scope full course.png'],
    outputs: ['Scope image artifacts only; Scope itself has no persistent Search mutation.'],
    caveats: ['Raw capture(s) are canonicalized through StripChrome/AutoStitch first. `scope full` is canonical, not raw.'],
    subtopics: ['scope/hole', 'scope/full', 'scope/mark', 'scope/dots', 'scope/path', 'scope/manifest', 'scope/contact-sheet', 'scope/templates']
  }),
  record('scope/hole', {
    parent: 'scope', aliases: ['scope/hn'], title: 'SCOPE HN — configured blind viewport', summary: 'Inspect a selected course hole; blind by default.', availability: AVAILABILITY.CLI_ONLY,
    forms: ['lab scope hN [--truth] [view flags]', 'lab scope --hole N IMAGE ANNOTATION.json [view flags]'],
    examples: ['set DT', 'scope h1'],
    caveats: ['Configured hN uses the manifest viewport without Annotation truth. `--truth` is explicit assistance, tainted, and forbidden in blind/test runs.']
  }),
  record('scope/full', { parent: 'scope', title: 'SCOPE FULL — whole canonical raster', summary: 'Inspect the complete canonical raster before Scope AutoCrop.', forms: ['lab scope full IMAGE [view flags]'], examples: ['lab scope full course.png'] }),
  record('scope/point', { parent: 'scope', aliases: ['scope/rect', 'scope/box'], title: 'SCOPE POINT / RECT — coordinate inspection', summary: 'Inspect a point or positive-size rectangle on a canonical input.', forms: ['lab scope IMAGE x,y [view flags]', 'lab scope IMAGE x,y,w,h [view flags]'], caveats: ['Coordinates are canonical image pixels.'] }),
  record('scope/mark', { parent: 'scope', title: 'SCOPE MARK — one-shot point overlay', summary: 'Render exactly one named point overlay.', forms: ['lab scope mark IMAGE NAME x,y [--color N] [view flags]'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true, options: [option('--out', 'Write the rendered artifact.', { value: 'FILE' }), option('--color', 'Set overlay color.', { value: 'N', constraints: 'numeric' }), ...scopeViewOptions], caveats: ['Requires exactly one x,y point.'] }),
  record('scope/dots', { parent: 'scope', title: 'SCOPE DOTS — one-shot multi-point overlay', summary: 'Render at least two named point overlays.', forms: ['lab scope dots IMAGE NAME x,y x,y ... [--color N] [view flags]'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true, options: [option('--out', 'Write the rendered artifact.', { value: 'FILE' }), option('--color', 'Set overlay color.', { value: 'N', constraints: 'numeric' }), ...scopeViewOptions], caveats: ['Requires at least two x,y points.'] }),
  record('scope/path', { parent: 'scope', title: 'SCOPE PATH — one-shot geometry overlay', summary: 'Render a named path without creating Search state.', forms: ['lab scope path IMAGE NAME x,y x,y ... [--color N] [view flags]'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true, options: [option('--out', 'Write the rendered artifact.', { value: 'FILE' }), option('--color', 'Set overlay color.', { value: 'N', constraints: 'numeric' }), ...scopeViewOptions], caveats: ['Requires at least one x,y point; use Search for persistent trails.'] }),
  record('scope/manifest', { parent: 'scope', title: 'SCOPE MANIFEST — batch cases', summary: 'Render manifest cases.', forms: ['lab scope --manifest MANIFEST.json [--case NAME] [--out-dir DIR]'], availability: AVAILABILITY.CLI_ONLY, sideEffects: ['Writes one or more output artifacts.'] }),
  record('scope/contact-sheet', { parent: 'scope', title: 'SCOPE CONTACT-SHEET — manifest overview', summary: 'Render a contact sheet for manifest cases.', forms: ['lab scope contact-sheet MANIFEST.json [--case NAME] [--out FILE]'], availability: AVAILABILITY.CLI_ONLY, sideEffects: ['Writes a contact-sheet artifact.'] }),
  record('scope/templates', { parent: 'scope', title: 'SCOPE TEMPLATES — available Scope templates', summary: 'List available Scope templates.', forms: ['lab scope templates'], availability: AVAILABILITY.CLI_ONLY, outputs: ['Template names and descriptions.'] }),
  record('search', {
    kind: 'command', group: 'LOOK', title: 'SEARCH — stateful Pages, pins, and trails',
    summary: 'Persist visual investigation state over a canonical raster.',
    forms: ['lab search start IMAGE NAME x,y [--page PAGE] [view flags]', 'lab search add NAME x,y [view flags]', 'lab search back NAME [view flags]', 'lab search branch NAME NEW_NAME [--page PAGE] [view flags]', 'lab search show NAME [view flags]', 'lab search revisit NAME POINT_NUMBER [view flags]', 'lab search log NAME', 'lab search list'],
    options: [
      option('--page', 'Choose the Page receiving/searching evidence.', { value: 'PAGE' }),
      option('--color', 'Set trail color.', { value: 'N', appliesTo: 'search start', constraints: 'numeric' }),
      option('--ttl', 'Set a temporary pin render-count lifetime.', { value: 'N', defaultValue: '3', appliesTo: 'search pin', constraints: 'numeric' }),
      option('--style', 'Choose pin styling.', { value: 'ring-dot|crosshair|diamond', appliesTo: 'search pin', constraints: 'one listed value' }),
      ...searchViewOptions
    ],
    examples: ['lab search start course.png h7 1143,1105', 'lab search page new scratch course.png', 'lab search pin h7 1050,1120 --ttl 3'],
    sideEffects: ['Writes append-only Search state and rendered artifacts for visual actions.'],
    caveats: ['Pages namespace overlays, not raster copies. Scope is stateless; Search owns persisted investigation.'],
    subtopics: ['search/page', 'search/pin']
  }),
  record('search/page', { parent: 'search', title: 'SEARCH PAGE — overlay namespace', summary: 'Create, choose, inspect, or clear a Search Page.', forms: ['lab search page new PAGE [IMAGE]', 'lab search page use PAGE [IMAGE]', 'lab search page list [IMAGE]', 'lab search page show PAGE [IMAGE] [view flags]', 'lab search page clear PAGE [IMAGE]'], sideEffects: ['new/use/clear write Search state; show writes a render artifact.'], caveats: ['Clear removes visible Page overlays but keeps historical event-log entries.'] }),
  record('search/pin', { parent: 'search', title: 'SEARCH PIN — temporary or retained point', summary: 'Add, style, retain, or release page pins.', forms: ['lab search pin NAME x,y [--ttl N] [--style STYLE] [--page PAGE]', 'lab search pin here NAME [--ttl N] [--style STYLE]', 'lab search pin style NAME STYLE', 'lab search keep NAME', 'lab search release NAME', 'lab search pins'], sideEffects: ['Pin operations write Search state; visual forms also write render artifacts.'], caveats: ['TempPins age by successful visual renders and never enter forensic panels.'] }),
  record('search/start', { parent: 'search', title: 'SEARCH START — begin a trail', summary: 'Create a named trail at a canonical point.', forms: ['lab search start IMAGE NAME x,y [--page PAGE] [view flags]'], sideEffects: ['Writes Search state and a trail render.'] }),
  record('search/add', { parent: 'search', title: 'SEARCH ADD — append a trail point', summary: 'Append a canonical point to an existing trail.', forms: ['lab search add NAME x,y [view flags]'], sideEffects: ['Writes Search state and a trail render.'] }),
  record('search/back', { parent: 'search', title: 'SEARCH BACK — hide the latest trail point', summary: 'Back up visible trail evidence without erasing history.', forms: ['lab search back NAME [view flags]'], sideEffects: ['Writes Search state and a trail render.'] }),
  record('search/branch', { parent: 'search', title: 'SEARCH BRANCH — branch visible trail evidence', summary: 'Create a new trail from visible evidence, optionally on another Page.', forms: ['lab search branch NAME NEW_NAME [--page PAGE] [view flags]'], sideEffects: ['Writes Search state and a trail render.'] }),
  record('search/show', { parent: 'search', title: 'SEARCH SHOW — render a trail', summary: 'Render the current visible trail state.', forms: ['lab search show NAME [view flags]'], sideEffects: ['Writes a render artifact and records successful visual scope state.'] }),
  record('search/revisit', { parent: 'search', title: 'SEARCH REVISIT — inspect historical point', summary: 'Render a chosen historical trail point.', forms: ['lab search revisit NAME POINT_NUMBER [view flags]'], availability: AVAILABILITY.CLI_ONLY, sideEffects: ['Writes a render artifact and records a revisit event.'] }),
  record('search/log', { parent: 'search', title: 'SEARCH LOG — event history', summary: 'Print a trail event log.', forms: ['lab search log NAME'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true }),
  record('search/list', { parent: 'search', title: 'SEARCH LIST — trails', summary: 'List known trails.', forms: ['lab search list'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true }),
  record('search/page/new', { parent: 'search/page', title: 'SEARCH PAGE NEW', summary: 'Create a Page for an image.', forms: ['lab search page new PAGE [IMAGE]'], sideEffects: ['Writes Search state.'] }),
  record('search/page/use', { parent: 'search/page', title: 'SEARCH PAGE USE', summary: 'Make a Page active.', forms: ['lab search page use PAGE [IMAGE]'], sideEffects: ['Writes Search state.'] }),
  record('search/page/list', { parent: 'search/page', title: 'SEARCH PAGE LIST', summary: 'List Pages for an image.', forms: ['lab search page list [IMAGE]'] }),
  record('search/page/show', { parent: 'search/page', title: 'SEARCH PAGE SHOW', summary: 'Render visible overlays for a Page.', forms: ['lab search page show PAGE [IMAGE] [view flags]'], sideEffects: ['Writes a render artifact and Search state.'] }),
  record('search/page/clear', { parent: 'search/page', title: 'SEARCH PAGE CLEAR', summary: 'Clear visible overlays while retaining event history.', forms: ['lab search page clear PAGE [IMAGE]'], sideEffects: ['Writes Search state.'] }),
  record('search/pin/here', { parent: 'search/pin', title: 'SEARCH PIN HERE', summary: 'Pin the latest Scope focus.', forms: ['lab search pin here NAME [--ttl N] [--style STYLE]'], availability: AVAILABILITY.CLI_ONLY }),
  record('search/pin/style', { parent: 'search/pin', title: 'SEARCH PIN STYLE', summary: 'Change a saved pin style.', forms: ['lab search pin style NAME ring-dot|crosshair|diamond'], availability: AVAILABILITY.CLI_ONLY, sideEffects: ['Writes Search state.'] }),
  record('search/pin/keep', { parent: 'search/pin', aliases: ['search/keep'], title: 'SEARCH PIN KEEP', summary: 'Retain a temporary pin.', forms: ['lab search keep NAME'], strictOptions: true, sideEffects: ['Writes Search state.'] }),
  record('search/pin/release', { parent: 'search/pin', aliases: ['search/release'], title: 'SEARCH PIN RELEASE', summary: 'Release a pin from visible state.', forms: ['lab search release NAME'], strictOptions: true, sideEffects: ['Writes Search state.'] }),
  record('search/pin/pins', { parent: 'search/pin', aliases: ['search/pins'], title: 'SEARCH PINS', summary: 'List known pins.', forms: ['lab search pins'], strictOptions: true }),
  record('traverse', {
    kind: 'command', group: 'LOOK', title: 'TRAVERSE — move over Search evidence', summary: 'Navigate canonical image space using hex, Cartesian, or polar moves.',
    forms: ['lab traverse start IMAGE NAME x,y [--radius N] [--page PAGE]', 'lab traverse start IMAGE NAME --annotation FILE --start T7|N7|B7 [--radius N] [--page PAGE]', 'lab traverse go NAME 1|2|3|4|5|6', 'lab traverse go NAME --xy DX,DY', 'lab traverse go NAME --polar DISTANCE,ANGLE', 'lab traverse back NAME', 'lab traverse show NAME', 'lab traverse log NAME', 'lab traverse list'],
    options: [
      option('--radius', 'Discrete hex travel distance in canonical px.', { value: 'N', defaultValue: '75', constraints: 'positive number' }),
      option('--page', 'Search Page receiving traversal evidence.', { value: 'PAGE' }),
      option('--annotation', 'Annotation source for an assisted start.', { value: 'FILE', appliesTo: 'traverse start with --start' }),
      option('--start', 'Explicit annotation anchor.', { value: 'Tn|Nn|Bn', appliesTo: 'traverse start', constraints: 'Nn only when Annotation explicitly owns badge coordinates' }),
      option('--xy', 'Move by Cartesian delta.', { value: 'DX,DY', appliesTo: 'traverse go' }),
      option('--polar', 'Move by polar distance and heading.', { value: 'DISTANCE,ANGLE', appliesTo: 'traverse go', constraints: '0° right; 90° down; 180° left; 270° up' }),
      option('--tile-out', 'Traversal preview tile size.', { value: 'N', defaultValue: '220', constraints: 'positive number' }),
      option('--no-grid', 'Suppress grid on traversal tiles.', { appliesTo: 'traverse visual forms' })
    ],
    examples: ['lab traverse start course.png walk 700,900', 'lab traverse go walk 2', 'lab traverse go walk --polar 110,330'],
    sideEffects: ['Writes Search trail/traversal state and rendered navigation artifacts.'],
    caveats: ['Hex handles are suggestions, not constraints. Tn/Bn/Nn assisted anchors use Annotation truth only when explicitly requested.']
  }),
  record('traverse/start', { parent: 'traverse', title: 'TRAVERSE START — create a traversal', summary: 'Start at a point or an explicitly requested Annotation anchor.', forms: ['lab traverse start IMAGE NAME x,y [--radius N] [--page PAGE]', 'lab traverse start IMAGE NAME --annotation FILE --start Tn|Nn|Bn [--radius N] [--page PAGE]'], sideEffects: ['Writes Search traversal state and a navigation render.'] }),
  record('traverse/go', { parent: 'traverse', title: 'TRAVERSE GO — move the cursor', summary: 'Move by a numbered hex neighbor, Cartesian delta, or polar distance/heading.', forms: ['lab traverse go NAME 1|2|3|4|5|6', 'lab traverse go NAME --xy DX,DY', 'lab traverse go NAME --polar DISTANCE,ANGLE'], sideEffects: ['Writes Search traversal state and a navigation render.'] }),
  record('traverse/back', { parent: 'traverse', title: 'TRAVERSE BACK', summary: 'Back up the current traversal.', forms: ['lab traverse back NAME [--no-grid] [--tile-out N]'], sideEffects: ['Writes Search traversal state and a navigation render.'] }),
  record('traverse/show', { parent: 'traverse', title: 'TRAVERSE SHOW', summary: 'Render a traversal at its current position.', forms: ['lab traverse show NAME [--no-grid] [--tile-out N]'], sideEffects: ['Writes a navigation render and records visual scope state.'] }),
  record('traverse/log', { parent: 'traverse', title: 'TRAVERSE LOG', summary: 'Print traversal events.', forms: ['lab traverse log NAME'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true }),
  record('traverse/list', { parent: 'traverse', title: 'TRAVERSE LIST', summary: 'List saved traversals.', forms: ['lab traverse list'], availability: AVAILABILITY.CLI_ONLY, strictOptions: true }),
  record('invariants', { kind: 'command', group: 'KNOW', title: 'INVARIANTS — observed renderer truths', summary: 'List observed renderer invariants or inspect one ID.', forms: ['lab invariants [ID]'], examples: ['lab invariants', 'lab invariants I21'], availability: AVAILABILITY.CLI_ONLY, caveats: ['The I22 basket card exists in source data but is not surfaced by this command.'] }),
  record('detectors', { kind: 'command', group: 'KNOW', title: 'DETECTORS — detector registry', summary: 'List detector knowledge or inspect one ID.', forms: ['lab detectors [ID]'], examples: ['lab detectors', 'lab detectors D04'], availability: AVAILABILITY.CLI_ONLY }),
  record('gates', { kind: 'command', group: 'KNOW', title: 'GATES — pipeline vocabulary', summary: 'List pipeline/gate knowledge or inspect one ID.', forms: ['lab gates [ID]'], examples: ['lab gates', 'lab gates 3'], availability: AVAILABILITY.CLI_ONLY, subtopics: ['gate-vocabulary'] }),
  record('cases', { kind: 'command', group: 'KNOW', title: 'CASES — hard-evidence cases', summary: 'List recorded hard-evidence cases.', forms: ['lab cases'], availability: AVAILABILITY.CLI_ONLY }),
  record('compile', { kind: 'command', group: 'RUN', title: 'COMPILE — inspect a sweep config', summary: 'Resolve and compile an algorithm config without raster execution.', forms: ['lab compile CONFIG.json'], examples: ['lab compile packages/alg/src/detectors/threeFactor/configs/default.json'], availability: AVAILABILITY.CLI_ONLY, outputs: ['Resolved plan only.'], caveats: ['Compile does not read raster inputs or execute the algorithm plan.'] }),
  record('sweep', {
    kind: 'command', group: 'RUN', title: 'SWEEP — StripChrome/AutoStitch + only algorithm execution path', summary: 'The only LAB command that executes the algorithm plan.',
    forms: ['lab sweep CONFIG.json INPUT... [TRUTH.json]', 'lab sweep --through GATE CONFIG.json INPUT... [TRUTH.json]', 'lab sweep batch [--through GATE] CONFIG.json SELECTOR...'],
    options: [option('--through', 'Execute the dependency-valid plan slice through this gate.', { value: 'G1|G2|G3', constraints: 'Only G1-G3 currently form valid prefixes; later cutoffs are rejected; there is no --stop-after' })],
    examples: ['lab sweep CONFIG.json course.png', 'lab sweep --through G3 CONFIG.json course.png'],
    sideEffects: ['Canonicalizes inputs, executes the plan, and writes algorithm artifacts plus run.receipt.json and run.receipt.txt for every case.'],
    outputs: ['Canonicalization report and chronological operation timeline; run.receipt.json is the canonical machine testimony, while run.receipt.txt is the chronological human report, alongside algorithm artifacts.'],
    caveats: ['INPUT is one or more PNG/JPG/JPEG captures. Optional TRUTH.json is evaluation-only. CLI has no --out-dir even though the operation accepts one.']
  }),
  record('sweep/through', { parent: 'sweep', title: 'SWEEP THROUGH — dependency-valid slice', summary: 'Execute from the plan start through a supported gate prefix.', forms: ['lab sweep --through G1|G2|G3 CONFIG.json INPUT... [TRUTH.json]'], availability: AVAILABILITY.CLI_ONLY, caveats: ['Only G1-G3 currently form dependency-complete prefixes and accepted cutoffs. There is no --stop-after.'] }),
  record('sweep/batch', {
    parent: 'sweep', aliases: ['sweep/batches'], title: 'SWEEP BATCH — manifest-backed corpus census',
    summary: 'Run the same dependency-valid Sweep slice across named dev/demo course cases.',
    forms: ['lab sweep batch [--through G1|G2|G3] CONFIG.json all', 'lab sweep batch [--through G1|G2|G3] CONFIG.json dev', 'lab sweep batch [--through G1|G2|G3] CONFIG.json demo', 'lab sweep batch [--through G1|G2|G3] CONFIG.json COURSE...'],
    options: [option('--through', 'Execute the dependency-valid plan slice for every selected case.', { value: 'G1|G2|G3', defaultValue: 'G3', constraints: 'Optional; only G1-G3 are valid batch cutoffs.' })],
		examples: ['lab sweep batch --through G3 CONFIG.json dev demo', 'lab sweep batch --through G3 CONFIG.json all', 'lab sweep batch --through G3 CONFIG.json Dashs TheRec'],
    sideEffects: ['Runs one real Sweep operation per manifest-backed case and writes per-case artifacts plus run.receipt.json and run.receipt.txt for every case.', 'Continues after an individual case failure; exits nonzero if any case failed.'],
		outputs: ['Per-case Sweep artifacts under artifacts/sweep/<config>/batches/<course>/<case>/, including run.receipt.json as canonical machine testimony and run.receipt.txt as the chronological human report, plus summary.txt and summary.json in the batches directory.', 'START and DONE/FAIL progress lines for every case, followed by the stable aggregate summary.'],
    caveats: ['Omit `--through` to use the batch default `G3`; `dev` and `demo` are selector groups; `all` expands both. Course aliases are resolved only when unambiguous.', 'The REC L/R captures are one stitched multi-input case; clean-full and thrown-full remain separate cases.', 'No truth is loaded implicitly. Batch selectors name raster cases, not Annotation JSON. Single-image `lab sweep` behavior is unchanged.']
  }),
  record('orient', { kind: 'command', group: 'PROVENANCE', title: 'ORIENT — frozen-reference auditor', summary: 'Run the machine-bound 3fd72 reference auditor.', forms: ['lab orient 3fd72 [--verbose]'], options: [option('--verbose', 'Print additional auditor detail.')], examples: ['lab orient 3fd72'], availability: AVAILABILITY.CLI_ONLY, caveats: ['The 3fd72 auditor has hardcoded/stale evidence paths. This help labels that existing state; it does not repair it.'] }),

  record('shell/help', { kind: 'shell', title: 'SHELL HELP', summary: 'Show catalog-backed help from the interactive LAB shell.', forms: ['help [COMMAND | TOPIC]', 'help --all', 'help here'], availability: AVAILABILITY.CLI_ONLY }),
  record('shell/history', { kind: 'shell', title: 'SHELL HISTORY', summary: 'Show commands entered in this interactive shell.', forms: ['history'], availability: AVAILABILITY.CLI_ONLY }),
  record('shell/run-script', { kind: 'shell', title: 'SHELL RUN-SCRIPT', summary: 'Execute LAB commands from a script through the same dispatcher.', forms: ['run-script FILE'], availability: AVAILABILITY.CLI_ONLY, sideEffects: ['Runs the listed commands; their normal side effects apply.'] }),
  record('shell/exit', { kind: 'shell', title: 'SHELL EXIT', summary: 'Leave the interactive LAB shell.', forms: ['exit', 'quit'], availability: AVAILABILITY.CLI_ONLY }),

  record('ui/scope', { parent: 'ui', title: 'UI / SCOPE', summary: 'Stateless canonical inspection by point, box, or full view.', forms: ['Workbench mode: Scope'], availability: AVAILABILITY.UI_ONLY, outputs: ['Scope artifact preview.'], caveats: ['Click/drag inspection does not mutate Search state.'] }),
  record('ui/search', { parent: 'ui', title: 'UI / SEARCH', summary: 'Pages, trails, pins, and retained-target branching.', forms: ['Workbench mode: Search'], availability: AVAILABILITY.UI_ONLY, sideEffects: ['Writes the selected Search Page and append-only event state.'], caveats: ['The `WRITING TO:` Page is explicit; retained targets stay untouched until branched/promoted.'] }),
  record('ui/traverse', { parent: 'ui', title: 'UI / TRAVERSE', summary: 'Resume or start a canonical traversal, then move by click, hex, Cartesian, or polar input.', forms: ['Workbench mode: Traverse'], availability: AVAILABILITY.UI_ONLY, sideEffects: ['Writes traversal movement as Search evidence.'], caveats: ['Hex circles are conveniences, not rails.'] }),
  record('ui/sweep', { parent: 'ui', title: 'UI / SWEEP', summary: 'Run the real Sweep operation with a selected config and inputs.', forms: ['Workbench mode: Sweep'], availability: AVAILABILITY.UI_ONLY, sideEffects: ['Executes the algorithm and writes algorithm artifacts.'], caveats: ['UI Sweep always runs the full plan; it currently has no --through control.'] }),

  record('raster-contract', { title: 'RASTER CONTRACT', summary: 'LAB visual work operates on canonical rasters, not pre-sanitized captures.', forms: ['raw capture(s) → StripChrome → AutoStitch → canonical raster → Scope/Search/Traverse/algorithm'], caveats: ['`scope full` is post-StripChrome/AutoStitch and pre-Scope AutoCrop.'] }),
  record('truth', { title: 'TRUTH AND BLIND WORK', summary: 'Truth assistance is explicit, tainted, and not a protection claim.', forms: ['lab scope hN --truth', 'lab traverse start IMAGE NAME --annotation FILE --start Tn|Nn|Bn'], caveats: ['Existing truth-firewall gaps are not repaired here. Help must not claim stronger protection than the runtime provides.', 'Blind/test modes reject recorded truth-taint where current runtime guards implement it.'] }),
  record('gate-vocabulary', { title: 'GATE VOCABULARY', summary: 'LAB knowledge and execution use one canonical gate order; shared-set is infrastructure ownership, not a scheduled gate.', forms: ['LAB knowledge catalog and Engine execution share one canonical order: G0 Intake, G1 Badges, G2 Baskets, G3 Visible Tees, G4 Endpoint Recovery, G5 Straight Test, G6 Assignment, G7 Bend Refinement'], caveats: ['`lab gates 3` queries the canonical G3 knowledge card; it is not an instruction to execute `--through G3`.', '`lab sweep --through` currently accepts only G1, G2, or G3 because only those prefixes are dependency-complete. `shared-set` is cross-gate infrastructure ownership, not a scheduled gate.'] }),
  record('availability', { title: 'AVAILABILITY LABELS', summary: 'Every catalog entry states what is actually exposed.', forms: Object.entries(AVAILABILITY_MEANING).map(([label, meaning]) => `${label} — ${meaning}`) }),
  record('known-limits', { title: 'KNOWN LIMITS', summary: 'Documented source/registry boundaries that help must label rather than paper over.', forms: ['fourLaneSensor — REGISTERED_NONEXECUTING', 'supportRoi — PARKED_UNREGISTERED', 'I22 basket card — INTERNAL_API_ONLY'], caveats: ['fourLaneSensor is registered/config-addressable but has no EngineUnit.', 'supportRoi is parked and unregistered.', 'The I22 basket card is not surfaced by `lab invariants`.'], subtopics: ['four-lane-sensor', 'support-roi', 'i22-basket-card'] }),
  record('four-lane-sensor', { aliases: ['fourlanesensor'], title: 'FOUR-LANE SENSOR', summary: 'Registered/config-addressable feature with no EngineUnit.', availability: AVAILABILITY.REGISTERED_NONEXECUTING, caveats: ['It cannot execute in the current engine plan. This is an exposed registry state, not an available detector.'] }),
  record('support-roi', { aliases: ['supportroi'], title: 'SUPPORT ROI', summary: 'Parked support-region source feature.', availability: AVAILABILITY.PARKED_UNREGISTERED, caveats: ['It is not registered, cannot be configured, and cannot execute.'] }),
  record('i22-basket-card', { aliases: ['i22-basket-family-signal', 'i22'], title: 'I22 BASKET CARD', summary: 'Basket card present in source data but not surfaced by the public invariants command.', availability: AVAILABILITY.INTERNAL_API_ONLY, caveats: ['`lab invariants` cannot inspect this card.'] })
]);

export const ROOT_COMMANDS = Object.freeze(HELP_CATALOG.filter((entry) => entry.kind === 'command'));
export const SHELL_FORMS = Object.freeze(HELP_CATALOG.filter((entry) => entry.kind === 'shell'));
export const EXECUTABLE_SWEEP_GATES = Object.freeze(['G1', 'G2', 'G3']);

const normalize = (value) => String(value ?? '').trim().toLowerCase().replace(/[\s/]+/g, '/').replace(/-+/g, '-').replace(/^\/|\/$/g, '');

export function findHelpRecord(query) {
  let key = Array.isArray(query) ? normalize(query.join('/')) : normalize(query);
  if (/^scope\/h\d+$/.test(key)) key = 'scope/hole';
  if (!key) return undefined;
  return HELP_CATALOG.find((entry) => normalize(entry.id) === key || entry.aliases.some((alias) => normalize(alias) === key));
}

export function recordsForParent(parent) {
  return HELP_CATALOG.filter((entry) => entry.parent === parent);
}

export function optionsForCommand(command) {
  const root = findHelpRecord(command);
  if (!root || root.kind !== 'command') return [];
  return root.options;
}

export function optionNamesForCommand(command) {
  return optionsForCommand(command).map((entry) => entry.name);
}

export function allTopicIds() {
  return HELP_CATALOG.map((entry) => entry.id);
}

/**
 * The parser-facing public surfaces observed in the existing CLI.  Keeping
 * this separate from the rendering fields lets tests catch a catalog omission
 * without changing parser authority or re-implementing parser dispatch.
 */
export const RECOGNIZED_EXECUTION_SURFACE = Object.freeze({
  roots: ROOT_COMMANDS.map((entry) => entry.id),
  shell: ['help', 'history', 'run-script', 'exit', 'quit'],
  options: Object.freeze({
    ui: ['--port', '--no-open'],
    scope: ['--truth', '--out', '--name', '--template', '--color', '--hole', '--manifest', '--case', '--out-dir', ...scopeViewOptions.map((entry) => entry.name)],
    search: ['--page', '--color', '--ttl', '--style', ...searchViewOptions.map((entry) => entry.name)],
    traverse: ['--radius', '--page', '--annotation', '--start', '--xy', '--polar', '--tile-out', '--no-grid'],
    sweep: ['--through'],
    orient: ['--verbose']
  }),
  leaves: Object.freeze({
    scope: ['hole', 'point', 'rect', 'full', 'mark', 'dots', 'path', 'manifest', 'contact-sheet', 'templates'],
    search: ['start', 'add', 'back', 'branch', 'show', 'revisit', 'log', 'list', 'page', 'pin'],
    'search/page': ['new', 'use', 'list', 'show', 'clear'],
    'search/pin': ['here', 'style', 'keep', 'release', 'pins'],
    traverse: ['start', 'go', 'back', 'show', 'log', 'list'],
    sweep: ['through', 'batch']
  })
});

export function coverageForCatalog() {
  const commandIds = new Set(ROOT_COMMANDS.map((entry) => entry.id));
  const shellForms = new Set(SHELL_FORMS.flatMap((entry) => entry.forms.flatMap((form) => form.split(/\s+\|\s+|\s+/).filter((word) => ['help', 'history', 'run-script', 'exit', 'quit'].includes(word)))));
  const missingRoots = RECOGNIZED_EXECUTION_SURFACE.roots.filter((name) => !commandIds.has(name));
  const missingShell = RECOGNIZED_EXECUTION_SURFACE.shell.filter((name) => !shellForms.has(name));
  const missingOptions = Object.fromEntries(Object.entries(RECOGNIZED_EXECUTION_SURFACE.options).map(([command, names]) => [command, names.filter((name) => !optionNamesForCommand(command).includes(name))]));
  const missingLeaves = Object.fromEntries(Object.entries(RECOGNIZED_EXECUTION_SURFACE.leaves).map(([command, names]) => [command, names.filter((leaf) => !findHelpRecord(`${command}/${leaf}`))]));
  return { missingRoots, missingShell, missingOptions, missingLeaves, recordCount: HELP_CATALOG.length, commandCount: ROOT_COMMANDS.length, shellCount: SHELL_FORMS.length };
}
