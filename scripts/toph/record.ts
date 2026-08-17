/**
 * Toph recording trace — Node harnesses only, never imported from src/.
 *
 * Implements the DESIGN.md Part 2 §10 schema restricted to what the P1 slice
 * emits. Keeps rasters in memory for in-process queries (labelmap lookup,
 * first-loss) and can persist manifest + PNG assets for later inspection.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import type { Trace, TophGeom } from '../../src/lib/toph/trace';

export interface StageInvocation {
	id: number;
	name: string;
	seq: number;
}

export interface AssetRecord {
	id: number;
	stage: number;
	name: string;
	kind: 'image' | 'mask' | 'labelmap';
	widthPx: number;
	heightPx: number;
	op?: { name: string; params: Record<string, number | string> };
	/** In-memory pixel data (copied at record time; masks may be mutated later by the pipeline). */
	data: Uint8Array | Uint16Array;
}

export interface EntityRecord {
	id: number;
	kind: string;
	stage: number;
	geom?: TophGeom;
	region?: { asset: number; label: number };
	attrs?: Record<string, number | string | boolean>;
}

export type EventRecord =
	| {
			t: 'check';
			stage: number;
			entity: number;
			name: string;
			op: 'gte' | 'lte' | 'range' | 'custom';
			value?: number;
			min?: number;
			max?: number;
			pass: boolean;
	  }
	| { t: 'decide'; stage: number; entity: number; outcome: 'kept' | 'rejected'; at?: string }
	| { t: 'derive'; stage: number; parents: number[]; children: number[]; kind: 'transform' }
	| {
			t: 'select';
			stage: number;
			name: string;
			kept: number[];
			rejected: number[];
			basis?: Record<string, number | string>;
	  }
	| { t: 'measure'; stage: number; entity: number; name: string; value: number };

export class RecordingTrace implements Trace {
	readonly enabled = true;
	readonly stages: StageInvocation[] = [];
	readonly assets: AssetRecord[] = [];
	readonly entities: EntityRecord[] = [];
	readonly events: EventRecord[] = [];
	private ids = new WeakMap<object, number>();
	private nextEntity = 1;
	private currentStage = 0;

	constructor(readonly pipeline: string) {}

	stage(name: string): number {
		const id = this.stages.length + 1;
		this.stages.push({ id, name, seq: id });
		this.currentStage = id;
		return id;
	}

	raster(
		name: string,
		kind: 'image' | 'mask' | 'labelmap',
		data: Uint8Array | Uint8ClampedArray | Uint16Array,
		widthPx: number,
		heightPx: number,
		opts?: { space?: string; op?: { name: string; params: Record<string, number | string> } }
	): number {
		const id = this.assets.length + 1;
		const copy =
			data instanceof Uint16Array ? new Uint16Array(data) : new Uint8Array(data);
		this.assets.push({
			id,
			stage: this.currentStage,
			name,
			kind,
			widthPx,
			heightPx,
			op: opts?.op,
			data: copy
		});
		return id;
	}

	spawn(
		kind: string,
		obj?: object,
		opts?: {
			space?: string;
			geom?: TophGeom;
			region?: { asset: number; label: number };
			attrs?: Record<string, number | string | boolean>;
		}
	): number {
		const id = this.nextEntity++;
		this.entities.push({
			id,
			kind,
			stage: this.currentStage,
			geom: opts?.geom,
			region: opts?.region,
			attrs: opts?.attrs
		});
		if (obj) this.ids.set(obj, id);
		return id;
	}

	idOf(obj: object): number {
		return this.ids.get(obj) ?? 0;
	}

	attrs(e: number, attrs: Record<string, number | string | boolean>): void {
		const entity = this.entities[e - 1];
		if (entity) entity.attrs = { ...entity.attrs, ...attrs };
	}

	private gate(
		e: number,
		name: string,
		op: 'gte' | 'lte' | 'range',
		value: number,
		pass: boolean,
		min?: number,
		max?: number
	): boolean {
		this.events.push({ t: 'check', stage: this.currentStage, entity: e, name, op, value, min, max, pass });
		if (!pass) {
			this.events.push({ t: 'decide', stage: this.currentStage, entity: e, outcome: 'rejected', at: name });
		}
		return pass;
	}

	gte(e: number, name: string, value: number, min: number): boolean {
		return this.gate(e, name, 'gte', value, value >= min, min, undefined);
	}

	lte(e: number, name: string, value: number, max: number): boolean {
		return this.gate(e, name, 'lte', value, value <= max, undefined, max);
	}

	range(e: number, name: string, value: number, min: number, max: number): boolean {
		return this.gate(e, name, 'range', value, value >= min && value <= max, min, max);
	}

	check(e: number, name: string, pass: boolean, value?: number): boolean {
		this.events.push({ t: 'check', stage: this.currentStage, entity: e, name, op: 'custom', value, pass });
		if (!pass && e !== 0) {
			this.events.push({ t: 'decide', stage: this.currentStage, entity: e, outcome: 'rejected', at: name });
		}
		return pass;
	}

	keep(e: number, obj?: object): void {
		this.events.push({ t: 'decide', stage: this.currentStage, entity: e, outcome: 'kept' });
		if (obj && e !== 0) this.ids.set(obj, e);
	}

	reject(e: number, at: string): void {
		this.events.push({ t: 'decide', stage: this.currentStage, entity: e, outcome: 'rejected', at });
	}

	transform(parent: object, child: object): number {
		const parentId = this.idOf(parent);
		const childId = parentId; // slice: emitted objects inherit the component's identity
		if (parentId !== 0) {
			this.ids.set(child, parentId);
			this.events.push({
				t: 'derive',
				stage: this.currentStage,
				parents: [parentId],
				children: [childId],
				kind: 'transform'
			});
		}
		return childId;
	}

	select(
		name: string,
		kept: readonly object[],
		rejected: readonly object[],
		basis?: Record<string, number | string>
	): void {
		this.events.push({
			t: 'select',
			stage: this.currentStage,
			name,
			kept: kept.map((o) => this.idOf(o)).filter((id) => id !== 0),
			rejected: rejected.map((o) => this.idOf(o)).filter((id) => id !== 0),
			basis
		});
	}

	measure(e: number, name: string, value: number): void {
		this.events.push({ t: 'measure', stage: this.currentStage, entity: e, name, value });
	}

	// ---- in-process query surface (used by the first-loss runner) ----

	assetByName(name: string): AssetRecord | undefined {
		return this.assets.find((a) => a.name === name);
	}

	/** Label at (x, y) in a labelmap asset; 0 = background. */
	labelAt(asset: AssetRecord, x: number, y: number): number {
		if (x < 0 || y < 0 || x >= asset.widthPx || y >= asset.heightPx) return 0;
		return asset.data[y * asset.widthPx + x];
	}

	/** Entity whose region is (asset, label). */
	entityForLabel(assetId: number, label: number): EntityRecord | undefined {
		return this.entities.find((e) => e.region?.asset === assetId && e.region.label === label);
	}

	eventsFor(entity: number): EventRecord[] {
		return this.events.filter((ev) => 'entity' in ev && ev.entity === entity);
	}

	selectFateOf(entity: number): { name: string; kept: boolean } | undefined {
		for (const ev of this.events) {
			if (ev.t !== 'select') continue;
			if (ev.kept.includes(entity)) return { name: ev.name, kept: true };
			if (ev.rejected.includes(entity)) return { name: ev.name, kept: false };
		}
		return undefined;
	}

	stageName(id: number): string {
		return this.stages[id - 1]?.name ?? `stage-${id}`;
	}

	/** Persist manifest + PNG assets. Pixel data goes to PNGs; the manifest stays jq-friendly. */
	finish(dir: string): string {
		mkdirSync(dir, { recursive: true });
		const assetMeta = this.assets.map((a) => {
			const uri = `assets/${String(a.id).padStart(3, '0')}-${a.name}.png`;
			return { id: a.id, stage: a.stage, name: a.name, kind: a.kind, widthPx: a.widthPx, heightPx: a.heightPx, op: a.op, uri };
		});
		mkdirSync(join(dir, 'assets'), { recursive: true });
		for (const a of this.assets) {
			const png = new PNG({ width: a.widthPx, height: a.heightPx });
			for (let i = 0; i < a.widthPx * a.heightPx; i += 1) {
				const v = a.data[i];
				const o = i * 4;
				if (a.kind === 'labelmap') {
					png.data[o] = v & 0xff;
					png.data[o + 1] = (v >> 8) & 0xff;
					png.data[o + 2] = 0;
				} else {
					const g = v ? 255 : 0;
					png.data[o] = g;
					png.data[o + 1] = g;
					png.data[o + 2] = g;
				}
				png.data[o + 3] = 255;
			}
			writeFileSync(join(dir, assetMeta.find((m) => m.id === a.id)!.uri), PNG.sync.write(png));
		}
		const manifest = {
			version: 1,
			meta: { pipeline: this.pipeline, startedAt: new Date().toISOString() },
			stages: this.stages,
			assets: assetMeta,
			entities: this.entities,
			events: this.events
		};
		const manifestPath = join(dir, 'manifest.json');
		writeFileSync(manifestPath, JSON.stringify(manifest));
		return manifestPath;
	}
}
