import basketSpriteData from '../../../detectors/threeFactor/assets/basket-sprite.json';
import {
	componentRef,
	learnBasketShellFamilyV1,
	materializeRasterComponentPixels,
	type BasketShellMargins,
	type ComponentRasterEvidence,
	type RasterComponentRef
} from '../../../detectors/threeFactor/componentAssembly';
import type { BrightDarkComponentFields } from '../../../detectors/threeFactor/componentField';
import type { ComponentStats } from '../../../detectors/threeFactor/components';
import { pxFn, pxKey, type PxC } from '../../../exec/board';
import { ComponentPxC } from '../../componentPxC';

interface BasketTemplate {
	readonly width: number;
	readonly height: number;
	readonly rows: readonly string[];
}

const template = basketSpriteData as BasketTemplate;
const templateWhiteOffsets = Uint32Array.from(
	template.rows.flatMap((row, y) =>
		[...row].flatMap((value, x) => (value === '1' ? [y * template.width + x] : []))
	)
);

export interface BasketFamilyMember {
	readonly body: ComponentStats;
	readonly areaRatio: number;
	readonly whiteCoverage: number;
}

export interface BasketFamily {
	readonly templateSize: readonly [number, number];
	readonly members: readonly BasketFamilyMember[];
}

export interface BasketShellMember {
	readonly candidate: BasketFamilyMember;
	readonly bbox: readonly [number, number, number, number];
	readonly blackPx: Uint32Array;
}

export interface BasketShellFamily {
	readonly margins: BasketShellMargins | null;
	readonly shellOffsets: Uint32Array;
	readonly members: readonly BasketShellMember[];
}

interface DetectFamilyArgs {
	readonly fields: BrightDarkComponentFields;
}

interface FindShellFamilyArgs {
	readonly family: BasketFamily;
	readonly fields: BrightDarkComponentFields;
}

interface FindPxArgs {
	readonly member: BasketShellMember;
	readonly raster: ComponentRasterEvidence;
}

interface FoundBasketPx {
	readonly parts: readonly RasterComponentRef[];
	readonly px: Uint32Array;
	readonly whitePx: number;
	readonly blackPx: number;
}

export const BasketPxC = {
	family: pxKey<BasketFamily>('px.baskets.family'),
	shellFamily: pxKey<BasketShellFamily>('px.baskets.shellFamily'),
	objects: pxKey<readonly Basket[]>('px.baskets')
} as const;

export const BasketFn = {
	detectFamily: pxFn<DetectFamilyArgs, BasketFamily>('fn.Basket.detectFamily'),
	findShellFamily: pxFn<FindShellFamilyArgs, BasketShellFamily>('fn.Basket.findShellFamily'),
	findPx: pxFn<FindPxArgs, FoundBasketPx>('fn.Basket.findPx')
} as const;

function countTemplateCoverage(body: ComponentStats, fields: BrightDarkComponentFields): number {
	let hit = 0;
	for (const offset of templateWhiteOffsets) {
		const x = offset % template.width;
		const y = (offset - x) / template.width;
		const global = (body.bboxY + y) * fields.bright.mask.width + body.bboxX + x;
		if (fields.bright.labels[global] === body.label) hit++;
	}
	return hit / Math.max(1, templateWhiteOffsets.length);
}

const detectFamilyCalculation = ({ fields }: DetectFamilyArgs): BasketFamily => {
	const members = fields.bright.components.flatMap((body) => {
		if (body.bboxW !== template.width || body.bboxH !== template.height) return [];
		const areaRatio = body.area / Math.max(1, templateWhiteOffsets.length);
		const whiteCoverage = countTemplateCoverage(body, fields);
		if (areaRatio < 0.96 || areaRatio > 1.03 || whiteCoverage < 0.96) return [];
		return [{ body, areaRatio, whiteCoverage } satisfies BasketFamilyMember];
	});
	return { templateSize: [template.width, template.height], members };
};

const findShellFamilyCalculation = ({ family, fields }: FindShellFamilyArgs): BasketShellFamily => {
	const margins = learnBasketShellFamilyV1(
		family.members.map((member) => member.body),
		fields.dark.components
	);
	if (!margins) {
		return { margins: null, shellOffsets: new Uint32Array(), members: [] };
	}
	const [left, top, right, bottom] = margins;
	const shellWidth = template.width + left + right;
	const shellHeight = template.height + top + bottom;
	const counts = new Uint16Array(shellWidth * shellHeight);
	for (const { body } of family.members) {
		const x0 = body.bboxX - left;
		const y0 = body.bboxY - top;
		for (let y = 0; y < shellHeight; y++) {
			const row = (y0 + y) * fields.dark.mask.width + x0;
			for (let x = 0; x < shellWidth; x++)
				if (fields.dark.mask.data[row + x]) counts[y * shellWidth + x]++;
		}
	}
	const consensus = Math.ceil(family.members.length * 0.75);
	const shellOffsets = Uint32Array.from(
		Array.from(counts).flatMap((count, offset) => (count >= consensus ? [offset] : []))
	);
	return {
		margins,
		shellOffsets,
		members: family.members.map((candidate) => {
			const x0 = candidate.body.bboxX - left;
			const y0 = candidate.body.bboxY - top;
			const blackPx = Uint32Array.from(
				Array.from(shellOffsets).flatMap((offset) => {
					const x = offset % shellWidth;
					const y = (offset - x) / shellWidth;
					const pixel = (y0 + y) * fields.dark.mask.width + x0 + x;
					return fields.dark.mask.data[pixel] ? [pixel] : [];
				})
			);
			return {
				candidate,
				bbox: [x0, y0, shellWidth, shellHeight] as const,
				blackPx
			};
		})
	};
};

const findPxCalculation = ({ member, raster }: FindPxArgs): FoundBasketPx => {
	const body = componentRef('bright', member.candidate.body);
	const white = materializeRasterComponentPixels(body, raster);
	const px = Uint32Array.from([...white, ...member.blackPx].sort((a, b) => a - b));
	return {
		parts: [body],
		px,
		whitePx: white.length,
		blackPx: member.blackPx.length
	};
};

export function registerBasket(pxc: PxC): void {
	pxc.register(BasketFn.detectFamily, detectFamilyCalculation);
	pxc.register(BasketFn.findShellFamily, findShellFamilyCalculation);
	pxc.register(BasketFn.findPx, findPxCalculation);
}

export interface BasketHas {
	readonly detectFamily: {
		readonly fn: typeof BasketFn.detectFamily.address;
		readonly body: RasterComponentRef;
	};
	readonly findShellFamily: {
		readonly fn: typeof BasketFn.findShellFamily.address;
		readonly margins: BasketShellMargins;
		readonly blackPx: Uint32Array;
	};
	readonly findPx: {
		readonly fn: typeof BasketFn.findPx.address;
		readonly body: RasterComponentRef;
	};
}

export class Basket {
	readonly bbox: readonly [number, number, number, number];
	readonly has: BasketHas;
	readonly px: Uint32Array;
	readonly whitePx: number;
	readonly blackPx: number;

	private constructor(
		member: BasketShellMember,
		found: FoundBasketPx,
		margins: BasketShellMargins
	) {
		const body = found.parts[0];
		if (!body) throw new Error('Basket requires a bright body.');
		this.bbox = member.bbox;
		this.px = found.px;
		this.whitePx = found.whitePx;
		this.blackPx = found.blackPx;
		this.has = {
			detectFamily: {
				fn: BasketFn.detectFamily.address,
				body: componentRef('bright', member.candidate.body)
			},
			findShellFamily: { fn: BasketFn.findShellFamily.address, margins, blackPx: member.blackPx },
			findPx: { fn: BasketFn.findPx.address, body }
		};
	}

	static detectFamily(pxc: PxC): BasketFamily {
		return pxc.call(BasketFn.detectFamily, { fields: pxc.get(ComponentPxC.fields) });
	}

	static findShellFamily(pxc: PxC): BasketShellFamily {
		return pxc.call(BasketFn.findShellFamily, {
			family: pxc.get(BasketPxC.family),
			fields: pxc.get(ComponentPxC.fields)
		});
	}

	static findPx(pxc: PxC): readonly Basket[] {
		const shellFamily = pxc.get(BasketPxC.shellFamily);
		if (!shellFamily.margins) return [];
		const fields = pxc.get(ComponentPxC.fields);
		const raster: ComponentRasterEvidence = {
			width: fields.bright.mask.width,
			height: fields.bright.mask.height,
			topPx: 0,
			brightLabels: fields.bright.labels,
			darkLabels: fields.dark.labels
		};
		return shellFamily.members.map((member) => {
			const found = pxc.call(BasketFn.findPx, { member, raster });
			return new Basket(member, found, shellFamily.margins!);
		});
	}
}
