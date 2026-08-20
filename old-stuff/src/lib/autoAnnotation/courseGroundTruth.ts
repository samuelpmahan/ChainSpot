import type { AnnotatedHole, HoleNumberBadgeAnchor, ImageAsset, SourcePoint } from '../domain/project';

/** The hand-authored reference points shipped with the IMG_5641 CV fixtures. */
export interface CourseGroundTruthHole {
	readonly number: number;
	readonly tee: SourcePoint;
	readonly basket: SourcePoint;
}

export interface CourseGroundTruth {
	readonly sourceFileName: string;
	readonly widthPx: number;
	readonly heightPx: number;
	readonly badges: readonly HoleNumberBadgeAnchor[];
	readonly holes: readonly CourseGroundTruthHole[];
}

const BADGES = [
	[1, 754.5, 448.5],
	[2, 577.5, 582.0],
	[3, 606.5, 670.5],
	[4, 444.0, 744.0],
	[5, 550.5, 813.0],
	[6, 550.5, 884.5],
	[7, 444.0, 982.5],
	[8, 461.0, 1068.0],
	[9, 338.0, 1304.5],
	[10, 195.5, 1555.0],
	[11, 241.0, 1818.0],
	[12, 375.0, 1644.5],
	[13, 572.0, 1535.0],
	[14, 703.5, 1426.0],
	[15, 906.0, 1277.0],
	[16, 1140.0, 966.5],
	[17, 965.0, 922.0],
	[18, 862.5, 778.0]
] as const;

const HOLES = [
	[1, 884.8377444109449, 431.9287297485859, 520.909799907873, 426.51990558136015],
	[2, 458.1890699314583, 572.3708514226876, 764.8909697077348, 561.3106463391507],
	[3, 736.6058148380408, 714.6225977184242, 495.14541111301537, 627.099586019013],
	[4, 430.7483576493411, 644.5234235908367, 432.3184616324048, 863.8527701115761],
	[5, 491.56578024851615, 853.0390314516907, 685.3405371507645, 796.3447522033824],
	[6, 680.3814775133769, 850.5247486359476, 438.8388685382941, 914.8063409675767],
	[7, 368.65962418131465, 982.3336860325766, 618.8090454892177, 950.4392544203181],
	[8, 514.9311375611513, 1010.8688843716736, 423.53780515507555, 1176.3405127485696],
	[9, 372.5817142119152, 1181.7862886590783, 306.87752170715316, 1413.0335179962228],
	[10, 260.3490808032921, 1463.0891774122085, 138.43612905330735, 1640.5876987977786],
	[11, 73.56806925413619, 1827.735355732454, 391.34286393147585, 1807.8273853587643],
	[12, 419.21206435573754, 1770.303751900341, 339.1160651426048, 1531.067445545252],
	[13, 446.8826273187712, 1472.9553053160814, 688.779301552193, 1590.6311067912745],
	[14, 680.1006626449425, 1506.8815001878377, 816.6160850013131, 1323.6636042303671],
	[15, 875.1573282347795, 1361.7653659724785, 1034.4051911294462, 1084.9287878265427],
	[16, 1156.1751121865675, 1179.2847661157596, 1128.1243178636212, 763.6529034629543],
	[17, 1069.9746471517396, 852.7679190008336, 872.8859719547469, 986.596640679826],
	[18, 788.5810990714863, 850.3708280038526, 1000.1876912467347, 438.4487575793592]
] as const;

export const IMG_5641_GROUND_TRUTH: CourseGroundTruth = {
	sourceFileName: 'IMG_5641.jpg',
	widthPx: 1290,
	heightPx: 2091,
	badges: BADGES.map(([number, xPx, yPx]) => ({ number, xPx, yPx, confidence: 1 })),
	holes: HOLES.map(([number, teeX, teeY, basketX, basketY]) => ({
		number,
		tee: { xPx: teeX, yPx: teeY },
		basket: { xPx: basketX, yPx: basketY }
	}))
};

export function groundTruthMatchesImage(
	image: Pick<ImageAsset, 'fileName' | 'widthPx' | 'heightPx'>,
	groundTruth: CourseGroundTruth = IMG_5641_GROUND_TRUTH
): boolean {
	const normalizeFileName = (fileName: string): string => fileName.toLowerCase().replace(/\s+/g, '');
	return (
		normalizeFileName(image.fileName) === normalizeFileName(groundTruth.sourceFileName) &&
		image.widthPx === groundTruth.widthPx &&
		image.heightPx === groundTruth.heightPx
	);
}

/**
 * Applies only course endpoints. Existing shots, bends, widths, and IDs stay
 * intact so assigning reference points cannot erase round work.
 */
export function mergeCourseGroundTruth(
	currentHoles: readonly AnnotatedHole[],
	groundTruth: CourseGroundTruth,
	createId: () => string,
	defaultCorridorWidthPx: number
): AnnotatedHole[] {
	const existingByNumber = new Map(currentHoles.map((hole) => [hole.number, hole]));
	for (const truthHole of groundTruth.holes) {
		const existing = existingByNumber.get(truthHole.number);
		existingByNumber.set(truthHole.number, {
			...(existing ?? {
				id: createId(),
				number: truthHole.number,
				shots: [],
				corridorBends: [],
				corridorWidthPx: defaultCorridorWidthPx
			}),
			tee: truthHole.tee,
			basket: truthHole.basket
		});
	}
	return [...existingByNumber.values()].sort((left, right) => left.number - right.number);
}
