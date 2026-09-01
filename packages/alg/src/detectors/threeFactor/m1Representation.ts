import {
	componentRef,
	materializeRasterComponentPixels,
	type ComponentAssemblyRelationship,
	type ComponentRasterEvidence,
	type MaterializedComponentAssembly,
	type RasterComponentRef
} from './componentAssembly';
import type { BrightDarkComponentFields } from './componentField';
import type { Badge, Basket, ObjectGraph } from './objects';

export const M1_REPRESENTATION_SCHEMA = 'chainspot.object-representation-m1/v1' as const;

export interface M1RepresentationProvenance {
	readonly imageId: string;
	readonly paramsHash: string;
	readonly detector: string;
	readonly detectorVersion: string;
}

export type M1ObjectKind = 'badge' | 'basket';
export type M1ComponentRole = 'outer-bright' | 'dark-plate' | 'glyph' | 'white-body' | 'dark-shell';

export interface M1ComponentConsumer {
	readonly objectId: string;
	readonly objectKind: M1ObjectKind;
	readonly role: M1ComponentRole;
}

export interface M1PrimitiveComponent {
	readonly id: string;
	readonly polarity: 'bright' | 'dark';
	readonly label: number;
	readonly bbox: readonly [number, number, number, number];
	readonly area: number;
	readonly pixels: Uint32Array;
	readonly producedBy: 'badgeStage.components';
	readonly consumers: readonly M1ComponentConsumer[];
}

export interface M1ComponentRelationship {
	readonly id: string;
	readonly objectId: string;
	readonly containerComponentId: string;
	readonly memberComponentId: string;
	readonly predicate: ComponentAssemblyRelationship['predicate'];
	readonly selection: ComponentAssemblyRelationship['selection'];
	readonly margins?: readonly [number, number, number, number];
	readonly producedBy: 'component-backed-object-assembly-v1';
}

export interface M1KnownAccounting {
	readonly status: 'known';
	readonly universe: 'selected-bw-component-pixels';
	/** Exact B+W pixels justified as object evidence by V1 component selection. */
	readonly availablePixels: Uint32Array;
	/** Exact pixels consumed by the preserved V1 object composition. */
	readonly explainedPixels: Uint32Array;
	/** availablePixels \\ explainedPixels; retained even when empty. */
	readonly unexplainedPixels: Uint32Array;
}

export interface M1UnknownAccounting {
	readonly status: 'unknown';
	readonly reason: string;
}

export interface M1ObjectComposition {
	readonly id: string;
	readonly kind: M1ObjectKind;
	readonly detectorId: string;
	readonly assemblyStatus: 'assembled' | 'failed';
	readonly componentUses: readonly {
		readonly componentId: string;
		readonly role: M1ComponentRole;
	}[];
	readonly relationshipIds: readonly string[];
	readonly accounting: M1KnownAccounting | M1UnknownAccounting;
	readonly consumedBy: 'component-backed-object-assembly-v1';
}

/** One coherent run-scoped library: components are addressable by id without object semantics. */
export interface MaterializedM1Representation {
	readonly schema: typeof M1_REPRESENTATION_SCHEMA;
	readonly provenance: M1RepresentationProvenance;
	readonly raster: { readonly width: number; readonly height: number; readonly topPx: number };
	readonly components: readonly M1PrimitiveComponent[];
	readonly relationships: readonly M1ComponentRelationship[];
	readonly objects: readonly M1ObjectComposition[];
}

function componentId(ref: RasterComponentRef): string {
	return `component.${ref.polarity}.${ref.label}`;
}

function roleFor(kind: M1ObjectKind, index: number): M1ComponentRole {
	if (kind === 'badge') {
		if (index === 0) return 'outer-bright';
		if (index === 1) return 'dark-plate';
		return 'glyph';
	}
	return index === 0 ? 'white-body' : 'dark-shell';
}

function relationship(
	objectId: string,
	index: number,
	value: ComponentAssemblyRelationship
): M1ComponentRelationship {
	return {
		id: `relationship.${objectId}.${index}`,
		objectId,
		containerComponentId: componentId(value.container),
		memberComponentId: componentId(value.member),
		predicate: value.predicate,
		selection: value.selection,
		...(value.margins ? { margins: value.margins } : {}),
		producedBy: 'component-backed-object-assembly-v1'
	};
}

function samePixels(left: Uint32Array, right: Uint32Array): boolean {
	return left.length === right.length && left.every((pixel, index) => pixel === right[index]);
}

function assembledObject(
	object: Badge | Basket,
	assembly: MaterializedComponentAssembly,
	raster: ComponentRasterEvidence,
	consumers: Map<string, M1ComponentConsumer[]>,
	components: Map<string, M1PrimitiveComponent>,
	relationships: M1ComponentRelationship[]
): M1ObjectComposition {
	const kind = object.kind;
	const componentUses = assembly.components.map((ref, index) => {
		const id = componentId(ref);
		const role = roleFor(kind, index);
		const consumer = { objectId: object.id, objectKind: kind, role } as const;
		const priorConsumers = consumers.get(id) ?? [];
		priorConsumers.push(consumer);
		consumers.set(id, priorConsumers);
		if (!components.has(id))
			throw new Error(`${object.id}: selected primitive ${id} is absent from its ComponentField`);
		return { componentId: id, role };
	});
	const objectRelationships = assembly.relationships.map((value, index) =>
		relationship(object.id, index, value)
	);
	relationships.push(...objectRelationships);

	const available = Uint32Array.from(assembly.ownedPixels);
	const explained = Uint32Array.from(assembly.ownedPixels);
	if (!samePixels(available, explained))
		throw new Error(`${object.id}: M1 changed the preserved V1 B+W ownership set`);
	return {
		id: object.id,
		kind,
		detectorId: object.raster.detectorId,
		assemblyStatus: 'assembled',
		componentUses,
		relationshipIds: objectRelationships.map((value) => value.id),
		accounting: {
			status: 'known',
			universe: 'selected-bw-component-pixels',
			availablePixels: available,
			explainedPixels: explained,
			unexplainedPixels: new Uint32Array()
		},
		consumedBy: 'component-backed-object-assembly-v1'
	};
}

/**
 * Freeze the already-proven Badge/Basket B+W component composition as M1.
 * This only dereferences selections made by acquireObjectGraphV1; it performs
 * no thresholding, component search, matching, ownership expansion, or AA work.
 */
export function materializeM1Representation(
	graph: ObjectGraph,
	fields: BrightDarkComponentFields,
	provenance: M1RepresentationProvenance,
	topPx = 0
): MaterializedM1Representation {
	const raster: ComponentRasterEvidence = {
		width: fields.bright.mask.width,
		height: fields.bright.mask.height,
		topPx,
		brightLabels: fields.bright.labels,
		darkLabels: fields.dark.labels
	};
	const components = new Map<string, M1PrimitiveComponent>();
	const consumers = new Map<string, M1ComponentConsumer[]>();
	for (const [polarity, field] of [
		['bright', fields.bright],
		['dark', fields.dark]
	] as const) {
		for (const component of field.components) {
			const ref = componentRef(polarity, component, topPx);
			const id = componentId(ref);
			components.set(id, {
				id,
				polarity,
				label: component.label,
				bbox: ref.bbox,
				area: component.area,
				pixels: materializeRasterComponentPixels(ref, raster),
				producedBy: 'badgeStage.components',
				consumers: []
			});
		}
	}
	const relationships: M1ComponentRelationship[] = [];
	const objects = [...graph.badges, ...graph.baskets].map((object) => {
		const assembly = object.raster.componentAssembly;
		if (!assembly || assembly.status === 'failed') {
			return {
				id: object.id,
				kind: object.kind,
				detectorId: object.raster.detectorId,
				assemblyStatus: 'failed' as const,
				componentUses: [],
				relationshipIds: [],
				accounting: {
					status: 'unknown' as const,
					reason: assembly?.reason ?? 'no component-backed V1 assembly was attempted'
				},
				consumedBy: 'component-backed-object-assembly-v1' as const
			};
		}
		return assembledObject(object, assembly, raster, consumers, components, relationships);
	});

	return {
		schema: M1_REPRESENTATION_SCHEMA,
		provenance,
		raster: { width: raster.width, height: raster.height, topPx },
		components: [...components.values()].map((component) => ({
			...component,
			consumers: [...(consumers.get(component.id) ?? [])]
		})),
		relationships,
		objects
	};
}

export function encodeMaterializedM1Representation(
	value: MaterializedM1Representation
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify(value, (_key, field: unknown) =>
			field instanceof Uint32Array
				? { $chainspotTypedArray: 'u32', data: Array.from(field) }
				: field
		)
	);
}

export function decodeMaterializedM1Representation(
	bytes: Uint8Array
): MaterializedM1Representation {
	const value = JSON.parse(new TextDecoder().decode(bytes), (_key, field: unknown) => {
		if (!field || typeof field !== 'object' || !('$chainspotTypedArray' in field)) return field;
		const tagged = field as { $chainspotTypedArray: unknown; data: unknown };
		if (tagged.$chainspotTypedArray !== 'u32' || !Array.isArray(tagged.data))
			throw new Error('M1 representation has an unsupported typed-array payload');
		return Uint32Array.from(tagged.data);
	}) as MaterializedM1Representation;
	if (value.schema !== M1_REPRESENTATION_SCHEMA)
		throw new Error(`unsupported M1 representation schema '${String(value.schema)}'`);
	return value;
}
