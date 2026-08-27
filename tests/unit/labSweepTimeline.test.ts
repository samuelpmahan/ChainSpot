import { describe, expect, test, vi } from 'vitest';
import type { CompiledExecutionPlan, OperationSpec, Receipt } from '@chainspot/alg/exec';
import { printTimeline } from '../../scripts/chainspot-lab/sweep/timeline';

function operation(id: string, gate: string): OperationSpec {
	return {
		id,
		kind: 'compute',
		gate,
		unit: id,
		consumes: [],
		produces: []
	};
}

function plan(...ops: OperationSpec[]): CompiledExecutionPlan {
	return {
		ops,
		planFingerprint: 'timeline-test',
		bindings: {}
	};
}

function receipt(opId: string, durationMs = 1): Receipt {
	return {
		opId,
		startedAtMs: 0,
		durationMs,
		declaredConsumes: [],
		declaredProduces: [],
		actualConsumes: [],
		actualProduces: [],
		probes: [],
		artifacts: []
	};
}

describe('LAB sweep timeline', () => {
	test('prints operations in plan/receipt order across gates', () => {
		const output: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
		try {
			printTimeline(
				plan(operation('first', 'G1'), operation('second', 'G2'), operation('third', 'G1')),
				[receipt('first', 1), receipt('second', 2), receipt('third', 3)]
			);
		} finally {
			log.mockRestore();
		}

		const operationLines = output.filter((line) => /^    (first|second|third)\s/.test(line));
		expect(operationLines.map((line) => line.trim().split(/\s+/)[0])).toEqual([
			'first',
			'second',
			'third'
		]);
		expect(output.filter((line) => line === '  G1 Badges:')).toHaveLength(2);
		expect(output.filter((line) => line === '  G2 Baskets:')).toHaveLength(1);
	});

	test('shows repeated gate re-entry instead of collapsing it', () => {
		const output: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
		try {
			printTimeline(
				plan(operation('a', 'G1'), operation('b', 'G2'), operation('c', 'G1'), operation('d', 'G2')),
				[receipt('a'), receipt('b'), receipt('c'), receipt('d')]
			);
		} finally {
			log.mockRestore();
		}

		expect(output.filter((line) => line.endsWith(':') && line.startsWith('  G'))).toEqual([
			'  G1 Badges:',
			'  G2 Baskets:',
			'  G1 Badges:',
			'  G2 Baskets:'
		]);
	});

	test('reports an index mismatch loudly without remapping receipt evidence', () => {
		const output: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
		const first = receipt('second', 22);
		const second = receipt('first', 11);
		let drifted: readonly Receipt[] = [];
		try {
			drifted = printTimeline(plan(operation('first', 'G1'), operation('second', 'G2')), [first, second]);
		} finally {
			log.mockRestore();
		}

		expect(output).toContain(
			"    !!! RECEIPT MISMATCH at index 0: expected 'first', got 'second' !!!"
		);
		expect(output).toContain("    first: NO RECEIPT (index evidence belongs to 'second')");
		expect(output).toContain(
			"    !!! RECEIPT MISMATCH at index 1: expected 'second', got 'first' !!!"
		);
		expect(output).toContain("    second: NO RECEIPT (index evidence belongs to 'first')");
		expect(output.some((line) => line.includes('first  11.00ms'))).toBe(false);
		expect(output.some((line) => line.includes('second  22.00ms'))).toBe(false);
		expect(drifted).toEqual([first, second]);
	});

	test('reports a missing receipt at its planned operation index', () => {
		const output: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
		try {
			printTimeline(
				plan(operation('first', 'G1'), operation('second', 'G1')),
				[receipt('first', 5)]
			);
		} finally {
			log.mockRestore();
		}

		expect(output).toContain('    second: NO RECEIPT (did not run)');
		expect(output.some((line) => line.includes('second  '))).toBe(false);
		expect(output).toContain('  --- 1 ops, 5.00ms total, 0 artifacts, 0 conformance drift(s) ---');
	});

	test('reports an extra receipt as an out-of-plan mismatch and keeps it in totals', () => {
		const output: string[] = [];
		const log = vi.spyOn(console, 'log').mockImplementation((...args) => output.push(args.join(' ')));
		const extra = receipt('extra', 4);
		let drifted: readonly Receipt[] = [];
		try {
			drifted = printTimeline(plan(operation('first', 'G1')), [receipt('first', 1), extra]);
		} finally {
			log.mockRestore();
		}

		expect(output).toContain(
			"    !!! RECEIPT MISMATCH at index 1: no planned operation, got 'extra' !!!"
		);
		expect(output).toContain('  --- 2 ops, 5.00ms total, 0 artifacts, 1 conformance drift(s) ---');
		expect(drifted).toEqual([extra]);
	});
});
