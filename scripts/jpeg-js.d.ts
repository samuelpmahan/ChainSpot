declare module 'jpeg-js' {
	interface DecodeOptions {
		readonly useTArray?: boolean;
	}

	interface DecodedJpeg {
		readonly data: Uint8Array;
		readonly width: number;
		readonly height: number;
	}

	const jpeg: {
		decode(bytes: Uint8Array, options?: DecodeOptions): DecodedJpeg;
	};

	export default jpeg;
}
