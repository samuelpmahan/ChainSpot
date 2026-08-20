import { afterEach, describe, expect, it } from 'vitest';
import {
	DEFAULT_VISION_FLAGS,
	getVisionFlagsSnapshot,
	resetVisionFlags,
	setVisionFlag,
	visionFlagHelp,
	VISION_FLAGS_STORAGE_KEY
} from '../../src/lib/autoAnnotation/visionFlags';

class MemoryStorage implements Storage {
	private readonly values = new Map<string, string>();
	get length(): number { return this.values.size; }
	clear(): void { this.values.clear(); }
	getItem(key: string): string | null { return this.values.get(key) ?? null; }
	key(index: number): string | null { return Array.from(this.values.keys())[index] ?? null; }
	removeItem(key: string): void { this.values.delete(key); }
	setItem(key: string, value: string): void { this.values.set(key, value); }
}

const storage = new MemoryStorage();

describe('prestaging vision flags', () => {
	afterEach(() => {
		storage.clear();
		resetVisionFlags();
		Reflect.deleteProperty(globalThis, 'localStorage');
	});

	it('uses candidate defaults and returns immutable snapshots', () => {
		expect(getVisionFlagsSnapshot()).toEqual(DEFAULT_VISION_FLAGS);
		expect(Object.isFrozen(getVisionFlagsSnapshot())).toBe(true);
	});

	it('supports bounded console decisions and persists them', () => {
		Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
		expect(setVisionFlag('zeroBendShortcutEnabled', false).zeroBendShortcutEnabled).toBe(false);
		expect(setVisionFlag('zeroBendMaxDistancePx', 4).zeroBendMaxDistancePx).toBe(4);
		expect(setVisionFlag('p1Profile', 'historical').p1Profile).toBe('historical');
		expect(JSON.parse(storage.getItem(VISION_FLAGS_STORAGE_KEY) ?? '{}')).toEqual({
			zeroBendShortcutEnabled: false,
			zeroBendMaxDistancePx: 4,
			p1Profile: 'historical'
		});
	});

	it('rejects values outside the prestaging comparison matrix', () => {
		expect(() => setVisionFlag('zeroBendMaxDistancePx', 5 as 3 | 4)).toThrow();
		expect(() => setVisionFlag('p1Profile', 'other' as 'tuned' | 'historical')).toThrow();
	});

	it('exposes concise console help and reset', () => {
		expect(visionFlagHelp().set).toContain('zeroBendShortcutEnabled');
		setVisionFlag('zeroBendShortcutEnabled', false);
		expect(resetVisionFlags()).toEqual(DEFAULT_VISION_FLAGS);
	});
});
