// measurementTable renderer: the producer's own JSON, made readable.
//
// This kind is pure JSON written by ARTIFACT_EXTRACTORS via jsonBytes() (see
// packages/alg/src/exec/operations.ts). Every measurementTable producer today
// -- teeBadgeLock.evidence, assignment.selection.table,
// posteriorTeeRecovery.evidence -- was falling through to the "no renderer"
// stub, so a human had to open raw bytes to read a decision the engine had
// already written down in full.
//
// LAB never recomputes: this reads the exact bytes the sink wrote and lays
// them out. It does not re-derive, re-score, or reorder anything. Where the
// payload is an array of uniform objects it prints a real column table;
// otherwise it pretty-prints the structure. No schema is assumed, because
// this kind has no single shape across producers.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RendererFn, RendererOutput } from '../rendererContract';

/** Column order is first-seen key order across rows — the producer's own
 * ordering, never sorted, so the table reads the way it was written. */
function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
	const seen: string[] = [];
	for (const row of rows) {
		for (const key of Object.keys(row)) if (!seen.includes(key)) seen.push(key);
	}
	return seen;
}

function cell(value: unknown): string {
	if (value === null) return 'null';
	if (value === undefined) return '';
	if (typeof value === 'number') return String(Number(value.toFixed(6)));
	if (typeof value === 'string' || typeof value === 'boolean') return String(value);
	// Nested structure stays on one line so the column grid survives.
	return JSON.stringify(value);
}

function isUniformObjectArray(value: unknown): value is Record<string, unknown>[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((row) => typeof row === 'object' && row !== null && !Array.isArray(row))
	);
}

function table(rows: readonly Record<string, unknown>[]): string[] {
	const columns = columnsOf(rows);
	const body = rows.map((row) => columns.map((column) => cell(row[column])));
	const widths = columns.map((column, index) =>
		Math.max(column.length, ...body.map((cells) => cells[index]!.length))
	);
	const line = (cells: readonly string[]) =>
		cells.map((text, index) => text.padEnd(widths[index]!)).join(' | ').trimEnd();
	return [line(columns), line(widths.map((width) => '-'.repeat(width))), ...body.map(line)];
}

/** Arrays of uniform objects anywhere in the payload become tables; the rest
 * is printed as indented JSON so nothing is silently dropped. */
function sections(parsed: unknown): string[] {
	if (isUniformObjectArray(parsed)) return table(parsed);
	if (parsed === null || typeof parsed !== 'object') return [JSON.stringify(parsed, null, 2)];

	const lines: string[] = [];
	const scalars: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (isUniformObjectArray(value)) continue;
		if (value !== null && typeof value === 'object') continue;
		scalars[key] = value;
	}
	if (Object.keys(scalars).length) {
		for (const [key, value] of Object.entries(scalars)) lines.push(`${key} = ${cell(value)}`);
		lines.push('');
	}
	for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (isUniformObjectArray(value)) {
			lines.push(`-- ${key} (${value.length} row${value.length === 1 ? '' : 's'})`);
			lines.push(...table(value), '');
		} else if (value !== null && typeof value === 'object') {
			lines.push(`-- ${key}`);
			lines.push(JSON.stringify(value, null, 2), '');
		}
	}
	return lines;
}

export const renderMeasurementTable: RendererFn = (input): RendererOutput => {
	const { artifactRef, parsed, bytes, outDir, opId, gate } = input;
	const path = join(outDir, `${artifactRef.id}.txt`);

	if (parsed === undefined) {
		// Loud, not silent: the kind claims JSON and this payload was not.
		const text =
			`${artifactRef.id} (${gate} / ${opId})\n` +
			`UNKNOWN: measurementTable payload did not parse as JSON.\n` +
			`${bytes.byteLength} raw byte(s) written alongside this file.\n`;
		writeFileSync(path, text);
		// The kind's real product is the parsed producer table; this is a
		// text-only stub note standing in for it, same family as mask's
		// dims-unavailable fallback -- so this call did not render.
		return { filesWritten: [path], summary: 'UNPARSEABLE payload -- text note written', rendered: false };
	}

	const lines = sections(parsed);
	writeFileSync(path, [`${artifactRef.id} (${gate} / ${opId})`, '', ...lines].join('\n') + '\n');

	const rowCount = isUniformObjectArray(parsed)
		? parsed.length
		: Object.values(parsed as Record<string, unknown>).filter(isUniformObjectArray).length;
	return {
		filesWritten: [path],
		summary: isUniformObjectArray(parsed)
			? `${rowCount} row${rowCount === 1 ? '' : 's'} -> text table`
			: `${rowCount} table section${rowCount === 1 ? '' : 's'} -> text report`,
		rendered: true
	};
};
