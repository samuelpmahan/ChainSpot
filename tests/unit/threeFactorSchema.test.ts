// Guards that the checked-in JSON Schema file matches what the registry
// generates. When it fails: regenerate configs/threeFactor-config.schema.json
// with the JSON printed by the failure (or run the snippet in the comment
// below) — a conscious update, mirroring the paramsHash pin.
//
//   npx vitest run tests/unit/threeFactorSchema.test.ts (prints on mismatch)
import { describe, expect, test } from 'vitest';
import { buildConfigJsonSchema } from '@chainspot/alg/detectors/threeFactor/schema';
import { ENGINE_UNITS } from '@chainspot/alg/detectors/threeFactor';
import checkedIn from '@chainspot/alg/detectors/threeFactor/configs/threeFactor-config.schema.json';

describe('threeFactor config JSON Schema', () => {
	test('checked-in schema matches the registry-generated one', () => {
		const generated = buildConfigJsonSchema(ENGINE_UNITS.map((unit) => unit.id));
		expect(checkedIn).toEqual(JSON.parse(JSON.stringify(generated)));
	});
});
