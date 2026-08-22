import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeImageFile } from '../nuthing/decode';

const [, , input, output] = process.argv;
if (!input || !output) {
	console.error('Usage: tsx scripts/chainspot-lab/apgd-make-nup1.ts INPUT_IMAGE OUTPUT.rgba.bin');
	process.exit(2);
}

const image = decodeImageFile(input);
const header = Buffer.alloc(16);
header.write('NUP1', 0, 4, 'latin1');
header.writeUInt32LE(image.width, 4);
header.writeUInt32LE(image.height, 8);
header.writeUInt32LE(0, 12);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, Buffer.concat([
	header,
	Buffer.from(image.data.buffer, image.data.byteOffset, image.width * image.height * 4)
]));
console.log(`${input} -> ${output} ${image.width}x${image.height}`);
