/**
 * The standalone index map: the same three views as the Settings panel, with
 * room to breathe and a fourth view over the plugin's own usage ledger.
 *
 * Plain DOM + SVG on purpose. This page is served by the host for a new tab, so
 * it has no access to the Web UI's React or its theme tokens; it uses one small
 * palette that follows prefers-color-scheme instead of pretending to be part of
 * the app shell.
 */

const API = '/code-impact/api';

/** @type {{ root: string|null, roots: any[], data: any|null, view: string, selected: string|null, usage: any|null }} */
const state = { root: null, roots: [], data: null, view: 'architecture', selected: null, usage: null };

const $ = (id) => document.getElementById(id);
const view = $('view');
const detail = $('detail');

const LANG_COLOR = { ts: 'var(--ts)', js: 'var(--js)', go: 'var(--go)' };
const SVG = 'http://www.w3.org/2000/svg';

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value === undefined || value === null || value === false) continue;
		if (key === 'class') node.className = value;
		else if (key === 'text') node.textContent = value;
		else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
		else node.setAttribute(key, value === true ? '' : String(value));
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

function svgEl(tag, attrs = {}, ...children) {
	const node = document.createElementNS(SVG, tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (value === undefined || value === null) continue;
		node.setAttribute(key, String(value));
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

async function api(route, params) {
	const url = new URL(`${API}/${route}`, window.location.origin);
	for (const [key, value] of Object.entries(params ?? {})) if (value !== undefined && value !== null) url.searchParams.set(key, value);
	const response = await fetch(url, { headers: { accept: 'application/json' } });
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
	return body;
}

async function post(route, payload) {
	const response = await fetch(`${API}/${route}`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(payload ?? {}),
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(body?.error ?? `HTTP ${response.status}`);
	return body;
}

function age(ms) {
	if (ms === null || ms === undefined) return '—';
	if (ms < 1000) return 'just now';
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.round(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.round(m / 60);
	if (h < 48) return `${h}h ago`;
	return `${Math.round(h / 24)}d ago`;
}

function timeOf(ts) {
	if (!ts) return '—';
	const d = new Date(ts);
	return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

function langColor(lang) {
	return LANG_COLOR[lang] ?? 'var(--other)';
}

function pickLanguage(dir) {
	const file = state.data?.files.find((f) => (dir === '.' ? !f.p.includes('/') : f.p.startsWith(`${dir}/`)));
	return file?.l ?? 'other';
}

/* ------------------------------------------------------------------ treemap */

/**
 * Binary partition: split the list in half by area, then split the rect along
 * the longer side. Less clever than squarify and much less code, and at this
 * size the difference is a few percent of aspect ratio.
 */
function partition(items, rect, out = []) {
	if (items.length === 0) return out;
	if (items.length === 1) {
		out.push({ item: items[0], ...rect });
		return out;
	}
	const total = items.reduce((sum, it) => sum + it.value, 0) || 1;
	let acc = 0;
	let split = 1;
	for (let i = 0; i < items.length - 1; i += 1) {
		acc += items[i].value;
		split = i + 1;
		if (acc >= total / 2) break;
	}
	const head = items.slice(0, split);
	const tail = items.slice(split);
	const headShare = head.reduce((sum, it) => sum + it.value, 0) / total;
	if (rect.w >= rect.h) {
		const w = rect.w * headShare;
		partition(head, { x: rect.x, y: rect.y, w, h: rect.h }, out);
		partition(tail, { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h }, out);
	} else {
		const h = rect.h * headShare;
		partition(head, { x: rect.x, y: rect.y, w: rect.w, h }, out);
		partition(tail, { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h }, out);
	}
	return out;
}

function renderArchitecture(box) {
	const data = state.data;
	const width = box.clientWidth || 900;
	const height = box.clientHeight || 600;
	const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' });

	const groups = (data.dirs.length ? data.dirs : [{ d: '.', files: data.files.length, symbols: data.files.length }])
		.map((dir) => ({
			dir,
			files: data.files.filter((f) => (dir.d === '.' ? !f.p.includes('/') : f.p.startsWith(`${dir.d}/`))),
			value: Math.max(1, dir.symbols),
		}))
		.filter((group) => group.files.length > 0)
		.sort((a, b) => b.value - a.value);

	const rects = partition(groups, { x: 0, y: 0, w: width, h: height });
	for (const cell of rects) {
		const files = cell.item.files
			.map((f) => ({ file: f, value: Math.max(1, f.n) }))
			.sort((a, b) => b.value - a.value);
		const inner = { x: cell.x + 1, y: cell.y + 18, w: Math.max(1, cell.w - 2), h: Math.max(1, cell.h - 19) };
		if (inner.w < 2 || inner.h < 2) continue;
		for (const leaf of partition(files, inner)) {
			const f = leaf.item.file;
			const active = state.selected === f.p;
			const rect = svgEl('rect', {
				x: leaf.x + 1,
				y: leaf.y + 1,
				width: Math.max(1, leaf.w - 2),
				height: Math.max(1, leaf.h - 2),
				rx: 3,
				fill: langColor(f.l),
				'fill-opacity': active ? 0.85 : 0.5,
				stroke: active ? 'var(--text)' : 'transparent',
				'stroke-width': active ? 1.5 : 0,
				style: 'cursor:pointer',
			});
			rect.addEventListener('click', () => select(f.p));
			rect.addEventListener('mouseenter', () => showTip(`${f.p} — ${f.n} symbols, ${f.x} exported`));
			rect.addEventListener('mouseleave', hideTip);
			rect.append(svgEl('title', {}, `${f.p}\n${f.n} symbols · ${f.x} exported · ${f.l}`));
			if (leaf.w > 90 && leaf.h > 22) {
				svg.append(rect);
				svg.append(svgEl('text', { x: leaf.x + 6, y: leaf.y + 14 }, f.p.split('/').pop()));
			} else {
				svg.append(rect);
			}
		}
		svg.append(svgEl('text', { x: cell.x + 6, y: cell.y + 13, style: 'font-weight:600;fill:var(--text)' }, cell.item.dir.d));
	}
	box.append(svg);
	box.append(legend());
}

function legend() {
	return el(
		'div',
		{ class: 'legend' },
		el('span', {}, el('i', { style: 'background: var(--ts)' }), 'TypeScript'),
		el('span', {}, el('i', { style: 'background: var(--js)' }), 'JavaScript'),
		el('span', {}, el('i', { style: 'background: var(--go)' }), 'Go'),
	);
}

function showTip(text) {
	let tip = document.getElementById('tip');
	if (!tip) {
		tip = el('div', { id: 'tip', style: 'position:fixed;pointer-events:none;background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:3px 8px;font-size:12px;z-index:9' });
		document.body.append(tip);
	}
	tip.textContent = text;
	tip.style.display = 'block';
	document.onmousemove = (event) => {
		tip.style.left = `${event.clientX + 12}px`;
		tip.style.top = `${event.clientY + 12}px`;
	};
}

function hideTip() {
	const tip = document.getElementById('tip');
	if (tip) tip.style.display = 'none';
}

/* ------------------------------------------------------------------- imports */

function renderImports(box) {
	const data = state.data;
	const width = box.clientWidth || 900;
	const height = box.clientHeight || 600;
	const cx = width / 2;
	const cy = height / 2;
	const radius = Math.min(width, height) / 2 - 60;

	const nodes = data.files.filter((f) => f.i.length > 0 || data.edges.some((edge) => edge[1] === f.p));
	if (nodes.length === 0) {
		box.append(el('p', { class: 'empty', text: 'No resolved import edges in this workspace.' }));
		return;
	}
	const byPath = new Map(nodes.map((f, index) => [f.p, index]));
	const step = (Math.PI * 2) / nodes.length;
	const angleOf = (index) => index * step - Math.PI / 2;
	const pos = (index) => [cx + Math.cos(angleOf(index)) * radius, cy + Math.sin(angleOf(index)) * radius];

	const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}` });
	for (const [from, to] of data.edges) {
		const a = byPath.get(from);
		const b = byPath.get(to);
		if (a === undefined || b === undefined) continue;
		const [x1, y1] = pos(a);
		const [x2, y2] = pos(b);
		const active = state.selected === from || state.selected === to;
		svg.append(
			svgEl('path', {
				d: `M${x1},${y1} Q${cx},${cy} ${x2},${y2}`,
				fill: 'none',
				stroke: active ? 'var(--accent)' : 'var(--muted)',
				'stroke-opacity': active ? 0.9 : 0.18,
				'stroke-width': active ? 1.8 : 0.8,
			}),
		);
	}
	nodes.forEach((f, index) => {
		const [x, y] = pos(index);
		const r = 2.5 + Math.min(6, Math.sqrt(f.n));
		const dot = svgEl('circle', {
			cx: x,
			cy: y,
			r: state.selected === f.p ? r + 2 : r,
			fill: langColor(f.l),
			style: 'cursor:pointer',
		});
		dot.addEventListener('click', () => select(f.p));
		dot.append(svgEl('title', {}, `${f.p}\n${f.n} symbols · ${f.i.length} imports`));
		svg.append(dot);
		if (nodes.length <= 60) {
			const label = svgEl('text', { x: x + r + 4, y: y + 3 }, f.p.split('/').pop());
			svg.append(label);
		}
	});
	box.append(svg);
	box.append(legend());
}

/* -------------------------------------------------------------- inheritance */

function renderTypes(box) {
	const data = state.data;
	const types = data.types ?? [];
	if (types.length === 0) {
		box.append(
			el('p', {
				class: 'empty',
				text: 'No extends / implements / embeds declarations in this workspace. Structural typing is not a declared edge, so an empty graph is expected here rather than wrong.',
			}),
		);
		return;
	}
	const width = box.clientWidth || 900;
	const height = box.clientHeight || 600;
	const byName = new Map();
	for (const type of types) {
		if (!byName.has(type.n)) byName.set(type.n, []);
		byName.get(type.n).push(type);
	}
	// Depth by the longest chain to a root; cycles (a compile error, but a
	// possible intermediate state) are cut by the visiting set.
	const depth = new Map();
	const visiting = new Set();
	const depthOf = (type) => {
		if (depth.has(type.id)) return depth.get(type.id);
		if (visiting.has(type.id)) return 0;
		visiting.add(type.id);
		let best = 0;
		for (const name of type.sup) {
			for (const parent of byName.get(name) ?? []) best = Math.max(best, depthOf(parent) + 1);
		}
		visiting.delete(type.id);
		depth.set(type.id, best);
		return best;
	};
	for (const type of types) depthOf(type);

	const columns = [];
	for (const type of types) {
		const d = depth.get(type.id) ?? 0;
		(columns[d] ??= []).push(type);
	}
	const colWidth = width / Math.max(1, columns.length);
	const nodeW = Math.min(150, colWidth - 16);
	const nodeH = 24;
	const pos = new Map();
	columns.forEach((column, d) => {
		const total = column.length * (nodeH + 8);
		const startY = Math.max(12, (height - total) / 2);
		column.forEach((type, index) => {
			pos.set(type.id, { x: d * colWidth + 8, y: startY + index * (nodeH + 8), w: nodeW, h: nodeH });
		});
	});

	const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}` });
	for (const type of types) {
		const from = pos.get(type.id);
		(type.sup ?? []).forEach((name, i) => {
			for (const parent of byName.get(name) ?? []) {
				const to = pos.get(parent.id);
				if (!to || !from) continue;
				const x1 = from.x + from.w;
				const y1 = from.y + from.h / 2;
				const x2 = to.x;
				const y2 = to.y + to.h / 2;
				const mid = (x1 + x2) / 2;
				svg.append(
					svgEl('path', {
						d: `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`,
						fill: 'none',
						stroke: type.hk?.[i] === 'implements' ? 'var(--warn)' : 'var(--muted)',
						'stroke-dasharray': type.hk?.[i] === 'implements' ? '4 3' : undefined,
						'stroke-opacity': 0.55,
						'stroke-width': 1,
					}),
				);
			}
		});
	}
	for (const type of types) {
		const box2 = pos.get(type.id);
		if (!box2) continue;
		const active = state.selected === type.p;
		const g = svgEl('g', { style: 'cursor:pointer' });
		g.append(
			svgEl('rect', {
				x: box2.x,
				y: box2.y,
				width: box2.w,
				height: box2.h,
				rx: 5,
				fill: 'var(--panel)',
				stroke: active ? 'var(--accent)' : 'var(--line)',
				'stroke-width': active ? 1.6 : 1,
			}),
			svgEl('text', { x: box2.x + 8, y: box2.y + 16, style: 'fill:var(--text)' }, `${type.n}`),
		);
		g.append(svgEl('title', {}, `${type.id}\n${type.kind} · ${type.p}:${type.l}`));
		g.addEventListener('click', () => select(type.p));
		svg.append(g);
	}
	box.append(svg);
	box.append(el('div', { class: 'legend' }, el('span', {}, el('i', { style: 'background: var(--muted)' }), 'extends'), el('span', {}, el('i', { style: 'background: var(--warn)' }), 'implements (dashed)')));
}

/* ------------------------------------------------------------------ sessions */

async function renderSessions(box) {
	if (!state.usage) state.usage = await api('usage');
	const usage = state.usage;
	box.append(
		el(
			'div',
			{ style: 'padding: 14px 18px; overflow:auto; height:100%' },
			el(
				'div',
				{ style: 'display:flex;align-items:center;gap:12px;margin-bottom:10px' },
				el('strong', {}, 'Sessions that used the tools'),
				el('span', { class: 'muted' }, `${usage.totals.sessions} session(s) · ${usage.totals.calls} call(s)`),
				el('span', { class: 'spacer', style: 'flex:1' }),
				el('button', {
					onclick: async () => {
						if (!window.confirm('Clear the usage ledger? The index is not touched.')) return;
						await post('usage/clear');
						state.usage = null;
						draw();
					},
				}, 'Clear'),
			),
			usage.sessions.length === 0
				? el('p', { class: 'muted' }, 'No call recorded yet. Ask the agent something that uses code_query or code_verify.')
				: el(
						'table',
						{},
						el('thead', {}, el('tr', {}, el('th', {}, 'session'), el('th', {}, 'workspace'), el('th', {}, 'calls'), el('th', {}, 'last used'))),
						el(
							'tbody',
							{},
							usage.sessions.map((session) =>
								el(
									'tr',
									{ class: 'session', onclick: () => showSession(session) },
									el('td', {}, el('code', {}, session.id)),
									el('td', { class: 'muted' }, session.cwd ?? '—'),
									el('td', {}, Object.entries(session.calls ?? {}).map(([tool, n]) => `${tool} ${n}`).join(' · ')),
									el('td', { class: 'muted' }, age(Date.now() - session.lastAt)),
								),
							),
						),
					),
		),
	);
}

function showSession(session) {
	detail.replaceChildren(
		el('h2', {}, `session ${session.id}`),
		el('p', { class: 'muted' }, session.cwd ?? 'no workspace recorded'),
		el('p', { class: 'muted' }, `first ${timeOf(session.firstAt)} · last ${timeOf(session.lastAt)}`),
		el('h2', { style: 'margin-top:14px' }, 'recent calls'),
		...session.events.map((event) =>
			el(
				'div',
				{ class: 'row' },
				el('span', { class: 'where' }, timeOf(event.at).split(' ').pop()),
				el(
					'span',
					{ class: 'what' },
					el('span', { class: 'kind' }, `${event.tool}${event.op ? ` ${event.op}` : ''}`),
					event.target ? el('code', {}, event.target) : null,
					el('div', { class: 'muted' }, event.outcome ?? ''),
				),
			),
		),
	);
}

/* -------------------------------------------------------------- file detail */

async function select(path) {
	state.selected = path;
	draw();
	detail.replaceChildren(el('p', { class: 'muted' }, 'loading…'));
	try {
		const file = await api('file', { root: state.root, path });
		detail.replaceChildren(
			el('h2', {}, file.path),
			el('p', { class: 'muted' }, `${file.lang} · ${file.symbols.length} symbols · exports: ${file.exports.join(', ') || 'none'}`),
			...file.symbols.map((symbol) =>
				el(
					'div',
					{ class: 'row' },
					el('span', { class: 'where' }, `${symbol.l}`),
					el(
						'span',
						{ class: 'what' },
						el('span', { class: 'kind' }, symbol.k),
						el('code', {}, symbol.q),
						symbol.s ? el('div', { class: 'muted' }, symbol.s) : null,
						symbol.h?.length ? el('div', { class: 'muted' }, symbol.h.map(([kind, name]) => `${kind} ${name}`).join(' · ')) : null,
					),
				),
			),
			file.imports.length ? el('h2', { style: 'margin-top:14px' }, 'imports') : null,
			...file.imports.map((imp) => el('div', { class: 'row' }, el('span', { class: 'where' }, `${imp.line}`), el('span', { class: 'what' }, el('code', {}, imp.spec), ` → ${imp.names}`))),
		);
	} catch (error) {
		detail.replaceChildren(el('p', { class: 'err' }, String(error.message ?? error)));
	}
}

/* -------------------------------------------------------------------- shell */

function chips() {
	const status = state.data?.status;
	if (!status) return [];
	const langs = Object.entries(status.langs ?? {}).map(([lang, n]) => `${lang} ${n}`).join(' · ');
	return [
		el('span', { class: 'chip' }, `${status.files} files`),
		el('span', { class: 'chip' }, `${status.symbols} symbols`),
		el('span', { class: 'chip' }, langs || 'no files'),
		el('span', { class: 'chip' }, `updated ${age(status.ageMs)}`),
		state.data.truncated ? el('span', { class: 'chip warn' }, `truncated to ${state.data.files.length}/${state.data.totalFiles}`) : null,
		status.skipped > 0 ? el('span', { class: 'chip warn' }, `${status.skipped} file(s) not parsed`) : null,
	].filter(Boolean);
}

async function draw() {
	const box = view;
	box.replaceChildren();
	if (!state.root) {
		box.append(el('p', { class: 'empty' }, 'No workspace indexed yet. Index one from Settings → Code Impact.'));
		return;
	}
	if (state.view === 'sessions') {
		try {
			await renderSessions(box);
		} catch (error) {
			box.append(el('p', { class: 'err' }, String(error.message ?? error)));
		}
		return;
	}
	if (!state.data) {
		box.append(el('p', { class: 'empty' }, 'loading…'));
		return;
	}
	if (state.view === 'architecture') renderArchitecture(box);
	else if (state.view === 'imports') renderImports(box);
	else renderTypes(box);
}

async function loadRoot(root, { refresh = false } = {}) {
	state.root = root;
	state.selected = null;
	state.data = null;
	$('chips').replaceChildren();
	draw();
	try {
		state.data = await api('overview', { root, refresh: refresh ? '1' : undefined });
		$('chips').replaceChildren(...chips());
		draw();
	} catch (error) {
		view.replaceChildren(el('p', { class: 'err' }, String(error.message ?? error)));
	}
}

function fillRoots(payload) {
	const select = $('root');
	select.replaceChildren();
	for (const entry of payload.roots) {
		select.append(el('option', { value: entry.root }, `${entry.root} — ${entry.files} files`));
	}
	if (payload.roots.length === 0) select.append(el('option', { value: '' }, 'no indexed workspace'));
	$('root').value = payload.defaultRoot ?? payload.roots[0]?.root ?? '';
}

async function boot() {
	const rootsPayload = await api('roots').catch((error) => ({ roots: [], defaultRoot: null, error }));
	state.roots = rootsPayload.roots ?? [];
	fillRoots(rootsPayload);
	state.root = $('root').value || null;
	$('root').addEventListener('change', (event) => loadRoot(event.target.value));
	$('refresh').addEventListener('click', () => {
		state.usage = null;
		loadRoot(state.root, { refresh: true });
	});
	for (const button of $('tabs').querySelectorAll('button')) {
		button.addEventListener('click', () => {
			state.view = button.dataset.view;
			for (const other of $('tabs').querySelectorAll('button')) other.setAttribute('aria-selected', String(other === button));
			view.replaceChildren();
			draw();
		});
	}
	window.addEventListener('resize', () => draw());
	if (state.root) await loadRoot(state.root);
	else view.append(el('p', { class: 'empty' }, 'Nothing indexed yet.'));
}

boot().catch((error) => view.replaceChildren(el('p', { class: 'err' }, String(error.message ?? error))));
