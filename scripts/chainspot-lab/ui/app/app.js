const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const SVG = 'http://www.w3.org/2000/svg';

const app = {
	mode: 'scope',
	canonical: null,
	search: null,
	configs: [],
	scopeTool: 'point',
	searchTool: 'trail',
	dragStart: null,
	dragNow: null,
	suppressClick: false,
	selectedStart: null,
	traversal: null,
	sweep: null
};

async function api(path, options = {}) {
	const response = await fetch(path, {
		headers: options.body ? { 'content-type': 'application/json' } : undefined,
		...options,
		body: options.body ? JSON.stringify(options.body) : undefined
	});
	const payload = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(payload.error || `${response.status} ${response.statusText}`);
	return payload;
}

function toast(message) {
	const el = $('#toast');
	el.textContent = message;
	el.classList.remove('hidden');
	clearTimeout(toast.timer);
	toast.timer = setTimeout(() => el.classList.add('hidden'), 4500);
}

function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

function currentPages() {
	if (!app.canonical || !app.search) return [];
	return Object.values(app.search.pages || {}).filter((page) => page.imageId === app.canonical.imageId).sort((a, b) => a.name.localeCompare(b.name));
}

function activePage() {
	if (!app.canonical || !app.search) return null;
	return app.search.activePageByImage?.[app.canonical.imageId] || currentPages()[0]?.name || null;
}

function setMode(mode) {
	app.mode = mode;
	$$('#modeNav button').forEach((button) => button.classList.toggle('active', button.dataset.mode === mode));
	$$('.modeControls').forEach((controls) => controls.classList.add('hidden'));
	$(`#${mode}Controls`).classList.remove('hidden');
	$('#scopeArtifactCard').classList.toggle('hidden', mode !== 'scope' || !$('#scopeArtifact').src);
	$('#sweepResultCard').classList.toggle('hidden', mode !== 'sweep' || !app.sweep);
	renderAll();
}

function pointFromEvent(event) {
	if (!app.canonical) return null;
	const svg = $('#overlay');
	const rect = svg.getBoundingClientRect();
	const x = (event.clientX - rect.left) / rect.width * app.canonical.width;
	const y = (event.clientY - rect.top) / rect.height * app.canonical.height;
	return [Math.max(0, Math.min(app.canonical.width - 1, x)), Math.max(0, Math.min(app.canonical.height - 1, y))];
}

function svg(name, attrs = {}) {
	const el = document.createElementNS(SVG, name);
	for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
	return el;
}

function visibleTrailPoints(trail) {
	const byId = new Map((trail.points || []).map((point) => [point.id, point.point]));
	return (trail.visiblePointIds || []).map((id) => byId.get(id)).filter(Boolean);
}

function drawTrail(root, trail, kind = '') {
	const points = visibleTrailPoints(trail);
	if (points.length > 1) root.appendChild(svg('polyline', { points: points.map((p) => p.join(',')).join(' '), class: `trail ${kind}`.trim() }));
	for (const point of points) root.appendChild(svg('circle', { cx: point[0], cy: point[1], r: 7, class: `trailPoint ${kind === 'main' ? 'main' : ''}`.trim() }));
}

function drawPin(root, pin) {
	const [x, y] = pin.point;
	if (pin.style === 'diamond') {
		root.appendChild(svg('polygon', { points: `${x},${y - 12} ${x + 12},${y} ${x},${y + 12} ${x - 12},${y}`, class: 'pinDiamond' }));
		root.appendChild(svg('circle', { cx: x, cy: y, r: 2.5, class: 'pinDot' }));
	} else if (pin.style === 'crosshair') {
		root.appendChild(svg('line', { x1: x - 12, y1: y, x2: x - 4, y2: y, class: 'pinCross' }));
		root.appendChild(svg('line', { x1: x + 4, y1: y, x2: x + 12, y2: y, class: 'pinCross' }));
		root.appendChild(svg('line', { x1: x, y1: y - 12, x2: x, y2: y - 4, class: 'pinCross' }));
		root.appendChild(svg('line', { x1: x, y1: y + 4, x2: x, y2: y + 12, class: 'pinCross' }));
		root.appendChild(svg('circle', { cx: x, cy: y, r: 2.5, class: 'pinDot' }));
	} else {
		root.appendChild(svg('circle', { cx: x, cy: y, r: 11, class: 'pinRing' }));
		root.appendChild(svg('circle', { cx: x, cy: y, r: 2.5, class: 'pinDot' }));
	}
}

function drawPage(root, pageName, kind = '') {
	if (!app.search || !app.canonical || !pageName) return;
	for (const trail of Object.values(app.search.trails || {})) {
		if (trail.imageId === app.canonical.imageId && trail.page === pageName) drawTrail(root, trail, kind);
	}
	for (const pin of Object.values(app.search.pins || {})) {
		if (pin.imageId === app.canonical.imageId && pin.page === pageName) drawPin(root, pin);
	}
}

function drawTraverse(root) {
	if (!app.traversal) return;
	const [x, y] = app.traversal.current;
	root.appendChild(svg('circle', { cx: x, cy: y, r: 18, class: 'traverseNow' }));
	for (const neighbor of app.traversal.neighbors || []) {
		if (neighbor.point[0] < 0 || neighbor.point[1] < 0 || neighbor.point[0] >= app.canonical.width || neighbor.point[1] >= app.canonical.height) continue;
		const circle = svg('circle', { cx: neighbor.point[0], cy: neighbor.point[1], r: 22, class: 'hexMove', 'data-neighbor': neighbor.n });
		circle.addEventListener('click', async (event) => {
			event.stopPropagation();
			await moveTraverse({ kind: 'hex', neighbor: neighbor.n });
		});
		root.appendChild(circle);
		const label = svg('text', { x: neighbor.point[0], y: neighbor.point[1], class: 'hexLabel' });
		label.textContent = String(neighbor.n);
		root.appendChild(label);
	}
}

function renderOverlay() {
	const root = $('#overlay');
	root.innerHTML = '';
	if (!app.canonical) return;
	root.setAttribute('viewBox', `0 0 ${app.canonical.width} ${app.canonical.height}`);
	if (app.mode === 'search') {
		const page = activePage();
		if ($('#ghostMain').checked && page !== 'heritage-main') drawPage(root, 'heritage-main', 'ghost');
		drawPage(root, page, page === 'heritage-main' ? 'main' : '');
	} else if (app.mode === 'traverse') {
		if (app.traversal?.page !== 'heritage-main') drawPage(root, 'heritage-main', 'ghost');
		drawPage(root, app.traversal?.page || $('#traversePage').value, '');
		drawTraverse(root);
		if (!app.traversal && app.selectedStart) root.appendChild(svg('circle', { cx: app.selectedStart[0], cy: app.selectedStart[1], r: 16, class: 'selectedStart' }));
	} else if (app.mode === 'scope') {
		if (app.dragStart && app.dragNow) {
			const x = Math.min(app.dragStart[0], app.dragNow[0]);
			const y = Math.min(app.dragStart[1], app.dragNow[1]);
			const w = Math.abs(app.dragNow[0] - app.dragStart[0]);
			const h = Math.abs(app.dragNow[1] - app.dragStart[1]);
			root.appendChild(svg('rect', { x, y, width: w, height: h, class: 'scopeBox' }));
		}
	}
}

function renderPages() {
	const pages = currentPages();
	const active = activePage();
	const select = $('#pageSelect');
	const traverseSelect = $('#traversePage');
	const previousSearch = select.value;
	const previousTraverse = traverseSelect.value;
	select.innerHTML = '';
	traverseSelect.innerHTML = '';
	for (const page of pages) {
		for (const target of [select, traverseSelect]) {
			const option = document.createElement('option');
			option.value = page.name;
			option.textContent = page.name;
			target.appendChild(option);
		}
	}
	if (pages.length) {
		select.value = pages.some((p) => p.name === active) ? active : previousSearch;
		traverseSelect.value = pages.some((p) => p.name === previousTraverse) ? previousTraverse : active;
	}
	$('#writeTarget').textContent = `WRITING TO: ${active || 'NO PAGE'}`;
	$('#traverseWriteTarget').textContent = `WRITING TO: ${traverseSelect.value || active || 'NO PAGE'}`;
	$('#pageList').innerHTML = pages.length ? pages.map((page) => {
		const trailCount = Object.values(app.search.trails || {}).filter((trail) => trail.imageId === app.canonical.imageId && trail.page === page.name).length;
		const pinCount = Object.values(app.search.pins || {}).filter((pin) => pin.imageId === app.canonical.imageId && pin.page === page.name).length;
		return `<div class="pageRow ${page.name === active ? 'active' : ''}"><b>${esc(page.name)}</b><span class="muted">${trailCount} trail · ${pinCount} pin</span></div>`;
	}).join('') : '<div class="muted">No Pages on this raster yet.</div>';
}

function renderPins() {
	if (!app.canonical || !app.search) return;
	const page = activePage();
	const pins = Object.values(app.search.pins || {}).filter((pin) => pin.imageId === app.canonical.imageId && pin.page === page);
	$('#pinList').innerHTML = pins.length ? pins.map((pin) => `<div class="pinRow"><span>${esc(pin.name)} · ${esc(pin.style)} ${pin.kind === 'kept' ? '· KEPT' : `· ttl ${pin.ttlRemaining}`}</span><button data-keep="${esc(pin.name)}">keep</button><button data-release="${esc(pin.name)}">×</button></div>`).join('') : '<span class="muted">No pins on this Page.</span>';
	$$('[data-keep]').forEach((button) => button.onclick = () => searchAction({ action: 'pin-keep', name: button.dataset.keep }));
	$$('[data-release]').forEach((button) => button.onclick = () => searchAction({ action: 'pin-release', name: button.dataset.release }));
}

function renderEvents() {
	const events = app.search?.events || [];
	$('#eventLog').innerHTML = events.length ? events.slice(-120).map((event) => {
		const point = event.point ? ` @${event.point.map((n) => Math.round(n)).join(',')}` : '';
		const who = event.trail ? ` ${event.trail}` : event.pin ? ` ${event.pin}` : event.traversal ? ` ${event.traversal}` : '';
		const page = event.page ? ` [${event.page}]` : '';
		return `<div class="event"><span class="n">${event.id}</span><b>${esc(event.op)}</b>${esc(who)}${esc(page)}${esc(point)}${event.detail ? `<div class="muted">${esc(event.detail)}</div>` : ''}</div>`;
	}).join('') : '<div class="muted">No Search events yet.</div>';
	$('#eventLog').scrollTop = $('#eventLog').scrollHeight;
}

function renderMutationExplain() {
	const el = $('#mutationExplain');
	if (!app.canonical) { el.innerHTML = 'Open a raster to begin.'; return; }
	if (app.mode === 'scope') el.innerHTML = '<b>Scope is stateless.</b> Clicking creates an inspection artifact but does not change Search.';
	if (app.mode === 'search') {
		const page = activePage();
		el.innerHTML = page ? `Next Search click writes to <b>${esc(page)}</b>. ${page === 'heritage-main' ? '<span style="color:var(--orange)">This is your retained Page.</span>' : 'heritage-main stays untouched unless you explicitly promote/branch.'}` : '<b>No Page selected.</b> Create scratch or heritage-main before writing evidence.';
	}
	if (app.mode === 'traverse') {
		const page = app.traversal?.page || $('#traversePage').value || activePage();
		el.innerHTML = `Traverse motion is Search evidence. Every move appends to <b>${esc(page || 'NO PAGE')}</b>; the six hexes are only suggested moves.`;
	}
	if (app.mode === 'sweep') el.innerHTML = '<b>Sweep executes the algorithm.</b> It writes algorithm artifacts only; Search Pages remain unchanged.';
}

function renderAll() {
	if (app.canonical) {
		$('#emptyState').classList.add('hidden');
		$('#mapCard').classList.remove('hidden');
		$('#canonicalBadge').textContent = `${app.canonical.width}×${app.canonical.height} · CANONICAL`;
		$('#canonicalBadge').classList.remove('muted');
		$('#mapMeta').textContent = ` · StripChrome=${app.canonical.stripChrome?.source || 'none'} · AutoStitch=${app.canonical.autoStitch?.sourceCount || 1}`;
	} else {
		$('#emptyState').classList.remove('hidden');
		$('#mapCard').classList.add('hidden');
	}
	renderPages();
	renderPins();
	renderEvents();
	renderMutationExplain();
	renderOverlay();
}

function scopeView() {
	return {
		contextSpanPx: Number($('#contextSpan').value),
		localExtraWidthPx: Number($('#localW').value),
		localExtraHeightPx: Number($('#localH').value),
		forensicWidePx: Number($('#fw').value),
		forensicMidPx: Number($('#fm').value),
		forensicTightPx: Number($('#ft').value),
		grid: $('#grid').checked
	};
}

async function runScope(request) {
	if (!app.canonical) return toast('Open a raster first.');
	try {
		const result = await api('/api/scope', {
			method: 'POST',
			body: { imagePath: app.canonical.imagePath, annotationPath: app.canonical.annotationPath, request: { ...request, view: scopeView() } }
		});
		$('#scopeArtifact').src = `${result.artifactUrl}&t=${Date.now()}`;
		$('#scopeArtifactLink').href = result.artifactUrl;
		$('#scopeArtifactCard').classList.remove('hidden');
		$('#scopeArtifactCard').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
	} catch (error) { toast(error.message); }
}

async function searchAction(body) {
	if (!app.canonical) return toast('Open a raster first.');
	try {
		app.search = await api('/api/search/action', { method: 'POST', body });
		renderAll();
	} catch (error) { toast(error.message); }
}

async function createAndUsePage(name) {
	if (!app.canonical || !name.trim()) return;
	await searchAction({ action: 'page-new', imagePath: app.canonical.imagePath, imageId: app.canonical.imageId, page: name.trim() });
	await searchAction({ action: 'page-use', imageId: app.canonical.imageId, page: name.trim() });
}

async function searchClick(point) {
	const page = activePage();
	if (!page) return toast('Create a Search Page first.');
	if (app.searchTool === 'trail') {
		const name = $('#trailName').value.trim();
		if (!name) return toast('Trail name is required.');
		await searchAction({ action: 'path-click', name, imagePath: app.canonical.imagePath, imageId: app.canonical.imageId, page, point });
	} else {
		const name = $('#pinName').value.trim();
		if (!name) return toast('Pin name is required.');
		await searchAction({ action: 'pin-temp', name, imagePath: app.canonical.imagePath, imageId: app.canonical.imageId, page, point, ttl: 3, style: $('#pinStyle').value });
	}
}

async function startTraverse() {
	if (!app.canonical) return toast('Open a raster first.');
	const name = $('#traverseName').value.trim();
	const page = $('#traversePage').value || activePage();
	const anchor = $('#traverseAnchor').value.trim();
	if (!name || !page) return toast('Traverse needs a name and Page.');
	if (!anchor && !app.selectedStart) return toast('Click a start point on the map or enter Tn/Nn/Bn.');
	try {
		const result = await api('/api/traverse/action', {
			method: 'POST',
			body: {
				action: 'start', name, page,
				imagePath: app.canonical.imagePath, annotationPath: app.canonical.annotationPath, imageId: app.canonical.imageId,
				point: app.selectedStart, anchor: anchor || undefined,
				radiusPx: Number($('#traverseRadius').value)
			}
		});
		app.search = result.state;
		app.traversal = result.traversal;
		app.selectedStart = null;
		$('#traverseStatus').textContent = `NOW ${app.traversal.current.map((n) => n.toFixed(1)).join(', ')} · ${app.traversal.page}`;
		renderAll();
	} catch (error) { toast(error.message); }
}

async function moveTraverse(move) {
	if (!app.traversal) return toast('Start a traversal first.');
	try {
		const result = await api('/api/traverse/action', { method: 'POST', body: { action: 'move', name: app.traversal.name, move } });
		app.search = result.state;
		app.traversal = result.traversal;
		$('#traverseStatus').textContent = `NOW ${app.traversal.current.map((n) => n.toFixed(1)).join(', ')} · ${app.traversal.page}`;
		renderAll();
	} catch (error) { toast(error.message); }
}

function renderSweep(result) {
	app.sweep = result;
	$('#sweepResultCard').classList.remove('hidden');
	$('#sweepRunMeta').textContent = ` · ${result.configName} · ${result.renderedCount} rendered / ${result.stubbedCount} stubbed`;
	$('#sweepStatus').textContent = `Done. ${result.outDir}`;
	$('#sweepOps').innerHTML = `<table><thead><tr><th>op</th><th>gate</th><th>kind</th><th>artifacts</th></tr></thead><tbody>${result.ops.map((op) => {
		const receipt = result.receipts.find((candidate) => candidate.opId === op.id);
		return `<tr><td>${esc(op.id)}</td><td>${esc(op.gate)}</td><td>${esc(op.kind)}</td><td>${receipt?.artifactCount ?? 0}</td></tr>`;
	}).join('')}</tbody></table>`;
	const files = result.files.filter((file) => file.url);
	$('#artifactList').innerHTML = files.length ? files.map((file, index) => `<button data-artifact="${index}" title="${esc(file.relativePath)}">${esc(file.relativePath)}</button>`).join('') : '<span class="muted">No browser-viewable artifacts.</span>';
	$$('[data-artifact]').forEach((button) => {
		button.onclick = async () => {
			const file = files[Number(button.dataset.artifact)];
			const preview = $('#artifactPreview');
			if (['png', 'jpg', 'jpeg'].includes(file.kind)) preview.innerHTML = `<img src="${file.url}&t=${Date.now()}" alt="${esc(file.relativePath)}" />`;
			else {
				try {
					const text = await fetch(file.url).then((response) => response.text());
					preview.innerHTML = `<pre>${esc(text.slice(0, 30000))}</pre>`;
				} catch { preview.innerHTML = `<a target="_blank" href="${file.url}">Open ${esc(file.relativePath)}</a>`; }
			}
		};
	});
}

async function runSweep() {
	const configPath = $('#configSelect').value;
	const inputPaths = $('#sweepInputs').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	if (!configPath || !inputPaths.length) return toast('Sweep needs a config and at least one input.');
	$('#runSweep').disabled = true;
	$('#sweepStatus').textContent = 'Running…';
	try {
		const result = await api('/api/sweep/run', { method: 'POST', body: { configPath, inputPaths, truthPath: $('#sweepTruth').value.trim() || undefined } });
		renderSweep(result);
	} catch (error) {
		$('#sweepStatus').textContent = 'Failed.';
		toast(error.message);
	} finally { $('#runSweep').disabled = false; }
}

async function openRaster() {
	const imagePath = $('#imagePath').value.trim();
	const annotationPath = $('#annotationPath').value.trim();
	if (!imagePath) return toast('Raster path is required.');
	$('#openRaster').disabled = true;
	try {
		app.canonical = await api('/api/open', { method: 'POST', body: { imagePath, annotationPath: annotationPath || undefined } });
		app.search = await api('/api/state');
		app.traversal = null;
		app.selectedStart = null;
		$('#canonicalImage').src = `${app.canonical.imageUrl}?t=${Date.now()}`;
		$('#sweepInputs').value = app.canonical.imagePath;
		$('#sweepTruth').value = app.canonical.annotationPath || '';
		renderAll();
	} catch (error) { toast(error.message); }
	finally { $('#openRaster').disabled = false; }
}

$('#modeNav').addEventListener('click', (event) => {
	const button = event.target.closest('button[data-mode]');
	if (button) setMode(button.dataset.mode);
});
$('#openRaster').onclick = openRaster;
$('#scopePoint').onclick = () => { app.scopeTool = 'point'; $('#scopePoint').classList.add('active'); $('#scopeBox').classList.remove('active'); };
$('#scopeBox').onclick = () => { app.scopeTool = 'box'; $('#scopeBox').classList.add('active'); $('#scopePoint').classList.remove('active'); };
$('#scopeFull').onclick = () => runScope({ name: 'full', full: true });
$('#searchPathTool').onclick = () => { app.searchTool = 'trail'; $('#searchPathTool').classList.add('active'); $('#searchPinTool').classList.remove('active'); };
$('#searchPinTool').onclick = () => { app.searchTool = 'pin'; $('#searchPinTool').classList.add('active'); $('#searchPathTool').classList.remove('active'); };
$('#ghostMain').onchange = renderOverlay;
$('#pageSelect').onchange = () => searchAction({ action: 'page-use', imageId: app.canonical.imageId, page: $('#pageSelect').value });
$('#traversePage').onchange = () => { $('#traverseWriteTarget').textContent = `WRITING TO: ${$('#traversePage').value || 'NO PAGE'}`; renderMutationExplain(); };
$('#createPage').onclick = () => createAndUsePage($('#newPage').value.trim());
$$('.quick button[data-page]').forEach((button) => button.onclick = () => createAndUsePage(button.dataset.page));
$('#trailBack').onclick = () => searchAction({ action: 'path-back', name: $('#trailName').value.trim() });
$('#promoteTrail').onclick = async () => {
	const source = $('#trailName').value.trim();
	if (!source) return toast('Trail name is required.');
	if (!currentPages().some((page) => page.name === 'heritage-main')) await createAndUsePage('heritage-main');
	const fromPage = app.search.trails?.[source]?.page;
	if (fromPage && fromPage !== 'heritage-main') await searchAction({ action: 'page-use', imageId: app.canonical.imageId, page: fromPage });
	const name = `${source}-final-${Date.now().toString(36)}`;
	await searchAction({ action: 'path-branch', name: source, newName: name, page: 'heritage-main' });
};
$('#clearPage').onclick = () => {
	const page = activePage();
	if (!page) return;
	if (page === 'heritage-main' && !confirm('Clear heritage-main visible evidence? History remains, but the clean Page will be emptied.')) return;
	searchAction({ action: 'page-clear', imageId: app.canonical.imageId, page });
};
$('#startTraverse').onclick = startTraverse;
$('#goXY').onclick = () => moveTraverse({ kind: 'xy', dx: Number($('#dx').value), dy: Number($('#dy').value) });
$('#goPolar').onclick = () => moveTraverse({ kind: 'polar', distance: Number($('#distance').value), angleDeg: Number($('#angle').value) });
$('#traverseBack').onclick = async () => {
	if (!app.traversal) return toast('Start a traversal first.');
	try {
		const result = await api('/api/traverse/action', { method: 'POST', body: { action: 'back', name: app.traversal.name } });
		app.search = result.state;
		app.traversal = result.traversal;
		$('#traverseStatus').textContent = `NOW ${app.traversal.current.map((n) => n.toFixed(1)).join(', ')} · ${app.traversal.page}`;
		renderAll();
	} catch (error) { toast(error.message); }
};
$('#runSweep').onclick = runSweep;

$('#overlay').addEventListener('mousemove', (event) => {
	const point = pointFromEvent(event);
	if (point) $('#cursorReadout').textContent = `x ${point[0].toFixed(1)} · y ${point[1].toFixed(1)}`;
	if (app.mode === 'scope' && app.scopeTool === 'box' && app.dragStart) { app.dragNow = point; renderOverlay(); }
});
$('#overlay').addEventListener('pointerdown', (event) => {
	if (app.mode === 'scope' && app.scopeTool === 'box') {
		app.dragStart = pointFromEvent(event);
		app.dragNow = app.dragStart;
		app.suppressClick = true;
		$('#overlay').setPointerCapture(event.pointerId);
		renderOverlay();
	}
});
$('#overlay').addEventListener('pointerup', async (event) => {
	if (app.mode === 'scope' && app.scopeTool === 'box' && app.dragStart) {
		const end = pointFromEvent(event);
		const start = app.dragStart;
		app.dragStart = null;
		app.dragNow = null;
		const x = Math.min(start[0], end[0]), y = Math.min(start[1], end[1]);
		const w = Math.abs(end[0] - start[0]), h = Math.abs(end[1] - start[1]);
		renderOverlay();
		if (w >= 2 && h >= 2) await runScope({ name: `box-${Math.round(x)}-${Math.round(y)}`, box: [x, y, w, h] });
		setTimeout(() => app.suppressClick = false, 0);
	}
});
$('#overlay').addEventListener('click', async (event) => {
	if (app.suppressClick) return;
	const point = pointFromEvent(event);
	if (!point) return;
	if (app.mode === 'scope' && app.scopeTool === 'point') await runScope({ name: `point-${Math.round(point[0])}-${Math.round(point[1])}`, point });
	else if (app.mode === 'search') await searchClick(point);
	else if (app.mode === 'traverse') {
		if (app.traversal) await moveTraverse({ kind: 'absolute', point });
		else {
			app.selectedStart = point;
			$('#traverseStatus').textContent = `Selected start ${point.map((n) => n.toFixed(1)).join(', ')}. Click Start.`;
			renderOverlay();
		}
	}
});

async function boot() {
	try {
		const [configs, state] = await Promise.all([api('/api/configs'), api('/api/state')]);
		app.configs = configs.configs || [];
		app.search = state;
		$('#configSelect').innerHTML = app.configs.map((config) => `<option value="${esc(config)}">${esc(config)}</option>`).join('');
		const preferred = app.configs.find((config) => config.endsWith('/configs/default.json'));
		if (preferred) $('#configSelect').value = preferred;
		renderAll();
	} catch (error) { toast(error.message); }
}

boot();
