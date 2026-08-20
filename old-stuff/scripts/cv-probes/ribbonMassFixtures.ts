/**
 * Shared fixture data for the ribbon-mass TypeScript probes
 * (`compare-ribbon-mass-port.ts`, `ring-arc-spike.ts`). Copied verbatim
 * from `hole_path_tee_recovery.py` (GOLDEN_TRUTH/GOLDEN_BADGES/ALEX_TRUTH/
 * ALEX_BADGES): badges are the committed `detect-course` output, truth
 * mirrors courseGroundTruth.ts / AlexClarkSet project.json. Fixture-only —
 * production never sees truth.
 */
import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { unzipSync } from 'fflate';

/** [number, teeX, teeY, basketX, basketY] */
export type FixtureTruthHole = readonly [number, number, number, number, number];
/** [number, badgeX, badgeY] */
export type FixtureBadge = readonly [number, number, number];

export const GOLDEN_TRUTH: readonly FixtureTruthHole[] = [
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
];
export const GOLDEN_BADGES: readonly FixtureBadge[] = [
	[1, 755, 449], [2, 578, 582], [3, 607, 670], [4, 444, 744],
	[5, 551, 813], [6, 551, 885], [7, 444, 983], [8, 461, 1068],
	[9, 338, 1304], [10, 195, 1555], [11, 241, 1818], [12, 375, 1644],
	[13, 572, 1535], [14, 704, 1426], [15, 906, 1277], [16, 1140.5, 966],
	[17, 965, 922], [18, 862.5, 778]
];
export const ALEX_TRUTH: readonly FixtureTruthHole[] = [
	[1, 621, 1601, 773, 1327], [2, 636, 1289, 495, 1396],
	[3, 366, 1742, 296, 2002], [4, 373, 2055, 607, 1946],
	[5, 486, 1888, 763, 1896], [6, 677, 1847, 433, 1583],
	[7, 460, 1410, 512, 1167], [8, 449, 867, 526, 572],
	[9, 431, 665, 355, 371], [10, 384, 306, 439, 566],
	[11, 543, 510, 456, 275], [12, 459, 234, 607, 94],
	[13, 735, 74, 1018, 286], [14, 914, 311, 751, 110],
	[15, 706, 114, 674, 335], [16, 605, 445, 864, 795],
	[17, 681, 706, 491, 873], [18, 514, 1025, 582, 1199]
];
export const ALEX_BADGES: readonly FixtureBadge[] = [
	[1, 696, 1455], [2, 559, 1346], [3, 327, 1883], [4, 493, 2005],
	[5, 621, 1899], [6, 580, 1780], [7, 485, 1283], [8, 490, 716],
	[9, 390, 511], [10, 412, 438], [11, 497, 389], [12, 536, 161],
	[13, 821, 107], [14, 827, 203], [15, 686, 229], [16, 649.5, 574],
	[17, 576, 790], [18, 547.5, 1113]
];

export const FIXTURE_COURSES = [
	{ name: 'GoldenTeeSet', zip: 'resources/GoldenTeeSet.chainspot.zip', truth: GOLDEN_TRUTH, badges: GOLDEN_BADGES },
	{ name: 'AlexClarkSet', zip: 'resources/AlexClarkSet.chainspot.zip', truth: ALEX_TRUTH, badges: ALEX_BADGES }
] as const;

export function loadFixtureRaster(zipPath: string): {
	data: Uint8Array;
	widthPx: number;
	heightPx: number;
	channels: 4;
} {
	const entries = unzipSync(readFileSync(zipPath));
	const bytes = entries['images/source-original.jpg'];
	if (!bytes) throw new Error(`${zipPath} has no images/source-original.jpg`);
	const decoded = jpeg.decode(bytes, { useTArray: true, maxMemoryUsageInMB: 2048 });
	return { data: decoded.data, widthPx: decoded.width, heightPx: decoded.height, channels: 4 };
}
