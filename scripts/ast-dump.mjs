#!/usr/bin/env node
// Deterministic AST dump of the algorithm code, wherever it lives.
//
// One script, several views over the same parse. No timestamps, no hashes,
// sorted by path, so two runs on the same tree print byte-identical output
// and a diff between two revisions is a real diff.
//
//   node scripts/ast-dump.mjs                 # outline: every declaration, its fields and signatures
//   node scripts/ast-dump.mjs full            # every syntax node, indented, with line:col
//   node scripts/ast-dump.mjs json            # the outline as JSON
//   node scripts/ast-dump.mjs dupes           # the same name declared in more than one file
//   node scripts/ast-dump.mjs imports         # import graph and import cycles
//   node scripts/ast-dump.mjs dead            # exports nothing in the scanned tree imports
//   node scripts/ast-dump.mjs slots           # every {id, consumes, produces} literal: the slot graph
//
// Options:
//   --root <dir>       scan this directory (repeatable; default: packages/alg/src scripts/chainspot-lab src/lib)
//   --out <file>       write to a file instead of stdout
//   --include-tests    also scan tests/ and *.test.* files
//   --max-type <n>     truncate a type's source text to n chars in the outline (default 240; 0 = never)
//
// Always excluded: node_modules, old-stuff, dist, build, .svelte-kit, *.d.ts.

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import ts from 'typescript';

const argv = process.argv.slice(2);
const MODES = new Set(['outline', 'full', 'json', 'dupes', 'imports', 'dead', 'slots']);
let mode = 'outline';
const roots = [];
let out = null;
let includeTests = false;
let maxType = 240;
for (let i = 0; i < argv.length; i++) {
	const a = argv[i];
	if (MODES.has(a)) mode = a;
	else if (a === '--root') roots.push(argv[++i]);
	else if (a === '--out') out = argv[++i];
	else if (a === '--include-tests') includeTests = true;
	else if (a === '--max-type') maxType = Number(argv[++i]);
	else {
		console.error(`unknown argument: ${a}`);
		process.exit(2);
	}
}
if (roots.length === 0) roots.push('packages/alg/src', 'scripts/chainspot-lab', 'src/lib');

const REPO = resolve(dirname(new URL(import.meta.url).pathname), '..');
const EXCLUDED_DIRS = new Set(['node_modules', 'old-stuff', 'dist', 'build', '.svelte-kit', '.git']);
const EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']);

function walk(dir, acc) {
	let entries;
	try {
		entries = readdirSync(dir);
	} catch {
		return acc;
	}
	for (const name of entries.sort()) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (EXCLUDED_DIRS.has(name)) continue;
			if (!includeTests && name === 'tests') continue;
			walk(full, acc);
		} else if (EXTENSIONS.has(extname(name))) {
			if (name.endsWith('.d.ts') || name.endsWith('.d.mts')) continue;
			if (!includeTests && /\.(test|spec)\.[cm]?[jt]s$/.test(name)) continue;
			acc.push(full);
		}
	}
	return acc;
}

const files = [...new Set(roots.flatMap((r) => walk(resolve(REPO, r), [])))].sort();
const rel = (p) => relative(REPO, p).split(sep).join('/');

function scriptKind(path) {
	const ext = extname(path);
	if (ext === '.ts' || ext === '.mts' || ext === '.cts') return ts.ScriptKind.TS;
	return ts.ScriptKind.JS;
}

const sources = files.map((path) => ({
	path,
	rel: rel(path),
	sf: ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, scriptKind(path))
}));

const squash = (s) => s.replace(/\s+/g, ' ').trim();
function typeText(node, sf) {
	if (!node) return '';
	const text = squash(node.getText(sf));
	return maxType > 0 && text.length > maxType ? text.slice(0, maxType) + ' …' : text;
}
const isExported = (node) =>
	Boolean(node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) ||
	Boolean(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Export);
const nameOf = (node) => (node.name && ts.isIdentifier(node.name) ? node.name.text : node.name ? squash(node.name.getText()) : '');

// ---------------------------------------------------------------- outline

function memberLine(m, sf) {
	if (ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) {
		const opt = m.questionToken ? '?' : '';
		const ro = m.modifiers?.some((x) => x.kind === ts.SyntaxKind.ReadonlyKeyword) ? 'readonly ' : '';
		return `${ro}${nameOf(m)}${opt}: ${typeText(m.type, sf) || (m.initializer ? '= ' + typeText(m.initializer, sf) : 'any')}`;
	}
	if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
		return `${nameOf(m)}(${m.parameters.map((p) => paramText(p, sf)).join(', ')}): ${typeText(m.type, sf) || 'void'}`;
	}
	if (ts.isIndexSignatureDeclaration(m)) return `[${m.parameters.map((p) => paramText(p, sf)).join(', ')}]: ${typeText(m.type, sf)}`;
	if (ts.isConstructorDeclaration(m)) return `constructor(${m.parameters.map((p) => paramText(p, sf)).join(', ')})`;
	if (ts.isGetAccessor(m)) return `get ${nameOf(m)}(): ${typeText(m.type, sf)}`;
	if (ts.isSetAccessor(m)) return `set ${nameOf(m)}(${m.parameters.map((p) => paramText(p, sf)).join(', ')})`;
	if (ts.isEnumMember(m)) return `${nameOf(m)}${m.initializer ? ' = ' + typeText(m.initializer, sf) : ''}`;
	return squash(m.getText(sf));
}
function paramText(p, sf) {
	const opt = p.questionToken ? '?' : '';
	return `${squash(p.name.getText(sf))}${opt}: ${typeText(p.type, sf) || 'any'}${p.initializer ? ' = ' + typeText(p.initializer, sf) : ''}`;
}
function initializerSummary(init, sf) {
	if (!init) return '';
	if (ts.isObjectLiteralExpression(init)) {
		const keys = init.properties.map((p) => (p.name ? squash(p.name.getText(sf)) : '...')).join(', ');
		return `{ ${keys} }`;
	}
	if (ts.isArrayLiteralExpression(init)) return `[${init.elements.length} elements]`;
	if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
		return `(${init.parameters.map((p) => paramText(p, sf)).join(', ')}) => ${typeText(init.type, sf) || '…'}`;
	}
	if (ts.isCallExpression(init)) return `${squash(init.expression.getText(sf))}(…)`;
	if (ts.isAsExpression(init) || ts.isSatisfiesExpression(init)) return initializerSummary(init.expression, sf) + ' as ' + typeText(init.type, sf);
	if (ts.isStringLiteral(init) || ts.isNumericLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init)) return squash(init.getText(sf));
	if (init.kind === ts.SyntaxKind.TrueKeyword || init.kind === ts.SyntaxKind.FalseKeyword || init.kind === ts.SyntaxKind.NullKeyword) return init.getText(sf);
	return typeText(init, sf);
}

function outlineFile(src) {
	const { sf } = src;
	const decls = [];
	const imports = [];
	const reexports = [];
	for (const st of sf.statements) {
		if (ts.isImportDeclaration(st)) {
			const from = st.moduleSpecifier.text;
			const names = [];
			const c = st.importClause;
			if (c?.name) names.push(c.name.text);
			if (c?.namedBindings) {
				if (ts.isNamespaceImport(c.namedBindings)) names.push('* as ' + c.namedBindings.name.text);
				else names.push(...c.namedBindings.elements.map((e) => (e.propertyName ? `${e.propertyName.text} as ${e.name.text}` : e.name.text)));
			}
			imports.push({ from, names, typeOnly: Boolean(c?.isTypeOnly) });
			continue;
		}
		if (ts.isExportDeclaration(st)) {
			const from = st.moduleSpecifier?.text ?? null;
			const names = st.exportClause && ts.isNamedExports(st.exportClause) ? st.exportClause.elements.map((e) => e.name.text) : ['*'];
			reexports.push({ from, names });
			continue;
		}
		const exported = isExported(st);
		if (ts.isInterfaceDeclaration(st)) {
			decls.push({ kind: 'interface', name: st.name.text, exported, extends: (st.heritageClauses ?? []).flatMap((h) => h.types.map((t) => squash(t.getText(sf)))), members: st.members.map((m) => memberLine(m, sf)) });
		} else if (ts.isTypeAliasDeclaration(st)) {
			decls.push({ kind: 'type', name: st.name.text, exported, type: typeText(st.type, sf) });
		} else if (ts.isEnumDeclaration(st)) {
			decls.push({ kind: 'enum', name: st.name.text, exported, members: st.members.map((m) => memberLine(m, sf)) });
		} else if (ts.isClassDeclaration(st)) {
			decls.push({ kind: 'class', name: st.name?.text ?? '(anonymous)', exported, extends: (st.heritageClauses ?? []).flatMap((h) => h.types.map((t) => squash(t.getText(sf)))), members: st.members.map((m) => memberLine(m, sf)) });
		} else if (ts.isFunctionDeclaration(st)) {
			decls.push({ kind: 'function', name: st.name?.text ?? '(anonymous)', exported, signature: `(${st.parameters.map((p) => paramText(p, sf)).join(', ')}): ${typeText(st.type, sf) || '…'}` });
		} else if (ts.isVariableStatement(st)) {
			const flavour = st.declarationList.flags & ts.NodeFlags.Const ? 'const' : st.declarationList.flags & ts.NodeFlags.Let ? 'let' : 'var';
			for (const d of st.declarationList.declarations) {
				decls.push({ kind: flavour, name: squash(d.name.getText(sf)), exported, type: typeText(d.type, sf), value: initializerSummary(d.initializer, sf) });
			}
		} else if (ts.isModuleDeclaration(st)) {
			decls.push({ kind: 'namespace', name: nameOf(st), exported });
		} else if (ts.isExportAssignment(st)) {
			decls.push({ kind: 'export default', name: squash(st.expression.getText(sf)).slice(0, 80), exported: true });
		}
	}
	return { file: src.rel, imports, reexports, decls };
}

function printOutline(outlines) {
	const lines = [];
	for (const o of outlines) {
		lines.push(`\n# ${o.file}`);
		for (const im of o.imports) lines.push(`  import ${im.typeOnly ? 'type ' : ''}{ ${im.names.join(', ')} } from '${im.from}'`);
		for (const re of o.reexports) lines.push(`  export { ${re.names.join(', ')} }${re.from ? ` from '${re.from}'` : ''}`);
		for (const d of o.decls) {
			const ex = d.exported ? 'export ' : '';
			if (d.kind === 'interface' || d.kind === 'class' || d.kind === 'enum') {
				lines.push(`  ${ex}${d.kind} ${d.name}${d.extends?.length ? ' extends ' + d.extends.join(', ') : ''}`);
				for (const m of d.members) lines.push(`    ${m}`);
			} else if (d.kind === 'type') lines.push(`  ${ex}type ${d.name} = ${d.type}`);
			else if (d.kind === 'function') lines.push(`  ${ex}function ${d.name}${d.signature}`);
			else if (d.kind === 'const' || d.kind === 'let' || d.kind === 'var') lines.push(`  ${ex}${d.kind} ${d.name}${d.type ? ': ' + d.type : ''}${d.value ? ' = ' + d.value : ''}`);
			else lines.push(`  ${ex}${d.kind} ${d.name}`);
		}
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------- full

function printFull(srcs) {
	const lines = [];
	for (const { sf, rel: r } of srcs) {
		lines.push(`\n# ${r}`);
		const visit = (node, depth) => {
			const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
			let label = ts.SyntaxKind[node.kind];
			if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) label += ` ${node.text}`;
			else if (ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) label += ` ${JSON.stringify(node.text)}`;
			else if (node.kind >= ts.SyntaxKind.FirstKeyword && node.kind <= ts.SyntaxKind.LastKeyword) label += ` ${node.getText(sf)}`;
			lines.push(`${'  '.repeat(depth)}${label} @${line + 1}:${character + 1}`);
			node.forEachChild((c) => visit(c, depth + 1));
		};
		sf.forEachChild((c) => visit(c, 1));
	}
	return lines.join('\n');
}

// ---------------------------------------------------------------- dupes

function printDupes(outlines) {
	const byName = new Map();
	for (const o of outlines) {
		for (const d of o.decls) {
			if (d.kind === 'export default') continue;
			const list = byName.get(d.name) ?? [];
			list.push({ file: o.file, kind: d.kind, exported: d.exported });
			byName.set(d.name, list);
		}
	}
	const lines = ['# names declared in more than one file (same name, possibly different meaning)'];
	const names = [...byName.keys()].filter((n) => byName.get(n).length > 1).sort();
	for (const n of names) {
		lines.push(`\n${n}`);
		for (const hit of byName.get(n).sort((a, b) => a.file.localeCompare(b.file))) lines.push(`  ${hit.exported ? 'export ' : ''}${hit.kind}  ${hit.file}`);
	}
	lines.push(`\n${names.length} duplicated names across ${outlines.length} files`);
	return lines.join('\n');
}

// ---------------------------------------------------------------- imports

function resolveSpecifier(fromFile, spec) {
	if (!spec.startsWith('.')) return spec; // bare or aliased specifier: kept as-is
	const base = resolve(dirname(fromFile), spec);
	const candidates = [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), ...['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js'].map((e) => base + e)];
	for (const c of candidates) {
		try {
			if (statSync(c).isFile()) return rel(c);
		} catch {}
	}
	return rel(base) + ' (unresolved)';
}
function importGraph(outlines, srcs) {
	const byRel = new Map(srcs.map((s) => [s.rel, s]));
	const edges = new Map();
	for (const o of outlines) {
		const src = byRel.get(o.file);
		const targets = new Set();
		for (const im of [...o.imports, ...o.reexports.filter((r) => r.from)]) targets.add(resolveSpecifier(src.path, im.from));
		edges.set(o.file, [...targets].sort());
	}
	return edges;
}
function stronglyConnected(edges) {
	let index = 0;
	const stack = [];
	const on = new Set();
	const idx = new Map();
	const low = new Map();
	const sccs = [];
	const nodes = [...edges.keys()];
	const visit = (v) => {
		idx.set(v, index);
		low.set(v, index);
		index++;
		stack.push(v);
		on.add(v);
		for (const w of edges.get(v) ?? []) {
			if (!edges.has(w)) continue;
			if (!idx.has(w)) {
				visit(w);
				low.set(v, Math.min(low.get(v), low.get(w)));
			} else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
		}
		if (low.get(v) === idx.get(v)) {
			const comp = [];
			let w;
			do {
				w = stack.pop();
				on.delete(w);
				comp.push(w);
			} while (w !== v);
			if (comp.length > 1) sccs.push(comp.sort());
		}
	};
	for (const v of nodes) if (!idx.has(v)) visit(v);
	return sccs.sort((a, b) => a[0].localeCompare(b[0]));
}
function printImports(outlines, srcs) {
	const edges = importGraph(outlines, srcs);
	const lines = ['# import graph (file -> what it imports)'];
	for (const [file, targets] of [...edges.entries()].sort()) {
		lines.push(`\n${file}`);
		for (const t of targets) lines.push(`  -> ${t}`);
	}
	const sccs = stronglyConnected(edges);
	lines.push(`\n# import cycles (${sccs.length})`);
	for (const c of sccs) lines.push(`\n  ${c.join('\n  ')}`);
	return lines.join('\n');
}

// ---------------------------------------------------------------- dead

function printDead(outlines, srcs) {
	const byRel = new Map(srcs.map((s) => [s.rel, s]));
	const used = new Map(); // file -> Set(names) | '*'
	const mark = (file, name) => {
		if (used.get(file) === '*') return;
		if (name === '*') used.set(file, '*');
		else (used.get(file) ?? used.set(file, new Set()).get(file)).add(name);
	};
	for (const o of outlines) {
		const src = byRel.get(o.file);
		for (const im of o.imports) {
			const target = resolveSpecifier(src.path, im.from);
			for (const n of im.names) {
				if (n.startsWith('* as ')) mark(target, '*');
				else mark(target, n.includes(' as ') ? n.split(' as ')[0] : n);
			}
			if (im.names.length === 0) mark(target, '*'); // side-effect import
		}
		for (const re of o.reexports) {
			if (!re.from) continue;
			const target = resolveSpecifier(src.path, re.from);
			for (const n of re.names) mark(target, n);
		}
	}
	const lines = ['# exports that nothing in the scanned tree imports by name', '# (approximate: a file imported with `import *` or re-exported with `export *` counts as fully used; entry points and package.json "exports" are not scanned)'];
	let count = 0;
	for (const o of outlines) {
		const u = used.get(o.file);
		if (u === '*') continue;
		const dead = o.decls.filter((d) => d.exported && d.kind !== 'export default' && !(u && u.has(d.name)));
		if (!dead.length) continue;
		lines.push(`\n${o.file}`);
		for (const d of dead) {
			lines.push(`  ${d.kind} ${d.name}`);
			count++;
		}
	}
	lines.push(`\n${count} unreferenced exports`);
	return lines.join('\n');
}

// ---------------------------------------------------------------- slots

function stringArray(node) {
	if (!node || !ts.isArrayLiteralExpression(node)) return null;
	const out = [];
	for (const e of node.elements) {
		if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) out.push(e.text);
		else return null; // not a pure literal list; leave it to a human
	}
	return out;
}
function propOf(obj, name) {
	return obj.properties.find((p) => ts.isPropertyAssignment(p) && p.name && squash(p.name.getText()) === name)?.initializer;
}
function collectSlots(srcs) {
	const ops = [];
	for (const { sf, rel: r } of srcs) {
		const visit = (node) => {
			if (ts.isObjectLiteralExpression(node)) {
				const consumes = stringArray(propOf(node, 'consumes'));
				const produces = stringArray(propOf(node, 'produces'));
				if (consumes && produces) {
					const idNode = propOf(node, 'id');
					const gateNode = propOf(node, 'gate');
					const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
					ops.push({
						id: idNode && (ts.isStringLiteral(idNode) || ts.isNoSubstitutionTemplateLiteral(idNode)) ? idNode.text : idNode ? squash(idNode.getText(sf)) : '(no id)',
						gate: gateNode && ts.isStringLiteral(gateNode) ? gateNode.text : '',
						consumes,
						produces,
						where: `${r}:${line + 1}`
					});
				}
			}
			node.forEachChild(visit);
		};
		sf.forEachChild(visit);
	}
	return ops.sort((a, b) => a.id.localeCompare(b.id) || a.where.localeCompare(b.where));
}
function printSlots(srcs) {
	const ops = collectSlots(srcs);
	const lines = ['# every object literal with consumes:[...] and produces:[...] (operations and units), from source text only'];
	for (const op of ops) lines.push(`\n${op.id}${op.gate ? '  [' + op.gate + ']' : ''}  ${op.where}\n  reads:  ${op.consumes.join(', ') || '-'}\n  writes: ${op.produces.join(', ') || '-'}`);
	const producers = new Map();
	const consumers = new Map();
	for (const op of ops) {
		for (const s of op.produces) (producers.get(s) ?? producers.set(s, new Set()).get(s)).add(op.id);
		for (const s of op.consumes) (consumers.get(s) ?? consumers.set(s, new Set()).get(s)).add(op.id);
	}
	const slots = [...new Set([...producers.keys(), ...consumers.keys()])].sort();
	lines.push('\n# slot graph (slot: written by -> read by)');
	for (const s of slots) {
		const w = [...(producers.get(s) ?? [])].sort();
		const rd = [...(consumers.get(s) ?? [])].sort();
		lines.push(`  ${s}: ${w.length ? w.join(', ') : 'SEEDED (no writer in scanned code)'} -> ${rd.length ? rd.join(', ') : 'NOBODY READS'}`);
	}
	lines.push(`\n${ops.length} operations, ${slots.length} slots`);
	return lines.join('\n');
}

// ---------------------------------------------------------------- main

const header = `# ast-dump ${mode} | roots: ${roots.join(' ')} | files: ${files.length}${includeTests ? ' | tests included' : ''}`;
let body;
const outlines = mode === 'full' || mode === 'slots' ? null : sources.map(outlineFile);
switch (mode) {
	case 'outline':
		body = printOutline(outlines);
		break;
	case 'json':
		body = JSON.stringify({ roots, files: outlines }, null, 1);
		break;
	case 'full':
		body = printFull(sources);
		break;
	case 'dupes':
		body = printDupes(outlines);
		break;
	case 'imports':
		body = printImports(outlines, sources);
		break;
	case 'dead':
		body = printDead(outlines, sources);
		break;
	case 'slots':
		body = printSlots(sources);
		break;
}
const text = mode === 'json' ? body + '\n' : `${header}\n${body}\n`;
if (out) {
	writeFileSync(resolve(out), text);
	console.error(`${header}\nwrote ${out} (${text.length} chars)`);
} else process.stdout.write(text);
