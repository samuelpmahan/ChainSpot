export interface LabCourseManifest {
  readonly version: number;
  readonly course: string;
  readonly aliases?: readonly string[];
  readonly devDir: string;
  readonly image: string;
  readonly annotation?: string;
  readonly holes?: Readonly<Record<string, { readonly sourceBox: readonly [number, number, number, number] }>>;
}

export interface LabConfig {
  readonly version: 1;
  readonly course?: string;
  readonly corpusRoot?: string;
  readonly vars: Readonly<Record<string, string>>;
}

export interface LabCourseContext {
  readonly config: LabConfig;
  readonly manifest: LabCourseManifest;
  readonly corpusRoot: string;
  readonly devDir: string;
  readonly imagePath: string;
  readonly annotationPath?: string;
}

export interface LabCommandLogEntry {
  readonly at?: string;
  readonly course?: string | null;
  readonly argv?: readonly string[];
  readonly taints?: readonly string[];
  readonly [key: string]: unknown;
}

export const LAB_DIR: string;
export const REPO_ROOT: string;
export const COURSE_MANIFEST_DIR: string;
export const DEFAULT_CORPUS_ROOT: string;
export const LAB_CONFIG_PATH: string;
export const LAB_PRESET_DIR: string;
export const LAB_COMMAND_LOG: string;

export function listCourseManifests(): readonly (LabCourseManifest & { readonly path: string })[];
export function resolveCourseManifest(query: string): LabCourseManifest & { readonly path: string };
export function emptyLabConfig(): LabConfig;
export function loadLabConfig(): LabConfig;
export function saveLabConfig(config: LabConfig): LabConfig;
export function resolveCourseContext(config?: LabConfig): LabCourseContext;
export function runSetCommand(args: readonly string[]): number;
export function appendLabCommand(entry: LabCommandLogEntry): void;
export function readLabCommandLog(): readonly LabCommandLogEntry[];
export function assertBlindCommandLogClean(): void;
export function guardTruthTaint(argv: readonly string[]): void;
export function printTutorial(): void;
