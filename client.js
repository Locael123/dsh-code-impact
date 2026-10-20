window.__ModuleLoader__.load({
	id: 'dsh-code-impact',
	factory(require) {
		const ReactNS = require('react');
		const React = ReactNS && ReactNS.default ? ReactNS.default : ReactNS;
		const h = React.createElement;
		const { useState, useEffect, useMemo, useCallback } = React;

		// ---------------------------------------------------------------------
		// locale
		// ---------------------------------------------------------------------

		const DICT = {
			en: {
				title: 'Code Impact',
				subtitle: 'What this workspace is made of, from the symbol index.',
				tabArchitecture: 'Architecture',
				tabImports: 'Imports',
				tabTypes: 'Inheritance',
				refresh: 'Refresh',
				loading: 'Reading the index…',
				empty: 'No workspace is indexed yet.',
				emptyHint: 'Ask the agent to run code_query once, then refresh this page.',
				failed: 'Could not read the index',
				retry: 'Retry',
				files: 'files',
				symbols: 'symbols',
				names: 'names',
				updated: 'updated',
				skipped: 'file(s) could not be parsed and are NOT indexed',
				truncated: 'the graph is capped for readability; the tools still see every file',
				root: 'workspace',
				symbolsIn: 'Symbols',
				imports: 'Imports',
				exports: 'Exports',
				noSymbols: 'No symbols extracted from this file.',
				notExported: 'internal',
				selectHint: 'Pick a file or a type to see details.',
				typesEmpty: 'No indexed declaration extends or implements anything.',
				importsEmpty: 'No resolved import edges between indexed files.',
				architectureHint: 'area = number of symbols, grouped by directory',
				importsHint: 'node = file, line = resolved import',
				typesHint: 'left to right = base to derived',
				extends: 'extends',
				implements: 'implements',
				embeds: 'embeds',
				subs: 'derived from it',
				sups: 'derives from',
				openFile: 'Open file',
				close: 'Close',
				kindClass: 'class',
				kindInterface: 'interface',
				kindStruct: 'struct',
				kindFunction: 'fn',
				kindMethod: 'method',
				kindType: 'type',
				kindVariable: 'var',
				kindField: 'field',
				kindEnum: 'enum',
				kindTrait: 'trait',
				kindImpl: 'impl',
				indexPlaceholder: 'D:\\path\\to\\project',
				indexAction: 'Index folder',
				indexHint: 'Build an index for any folder on this machine; the pictures are drawn from it.',
				tabSessions: 'Sessions',
				sessionsHint: 'every call this plugin answered, newest session first',
				session: 'session',
				workspace: 'workspace',
				calls: 'calls',
				lastUsed: 'last used',
				noSessions: 'No call recorded yet. Ask for something that uses code_query or code_verify.',
				clear: 'Clear',
				clearConfirm: 'Clear the usage ledger? The index itself is not touched.',
				recentCalls: 'recent calls',
				openFull: 'Open full page',
				openFullHint: 'the same map in a browser tab, with more room',
			},
			zh: {
				title: '代码影响分析',
				subtitle: '这份索引看到的工作区结构。',
				tabArchitecture: '组织架构',
				tabImports: '依赖关系',
				tabTypes: '继承关系',
				refresh: '刷新',
				loading: '正在读取索引…',
				empty: '还没有索引任何工作区。',
				emptyHint: '让 agent 先跑一次 code_query，然后刷新这一页。',
				failed: '读不到索引',
				retry: '重试',
				files: '文件',
				symbols: '符号',
				names: '名字',
				updated: '更新于',
				skipped: '个文件无法解析，未进入索引',
				truncated: '为了可读性图被截断；工具本身仍然能看到全部文件',
				root: '工作区',
				symbolsIn: '符号',
				imports: '被依赖',
				exports: '导出',
				noSymbols: '这个文件没有提取到符号。',
				notExported: '内部',
				selectHint: '点一个文件或一个类型看详情。',
				typesEmpty: '索引里没有继承或实现关系的声明。',
				importsEmpty: '已索引文件之间没有解析出的 import 边。',
				architectureHint: '面积 = 符号数量，按目录分组',
				importsHint: '节点 = 文件，线 = 已解析的 import',
				typesHint: '从左到右 = 基类到派生类',
				extends: '继承',
				implements: '实现',
				embeds: '嵌入',
				subs: '派生于它',
				sups: '派生自',
				openFile: '打开文件',
				close: '关闭',
				kindClass: '类',
				kindInterface: '接口',
				kindStruct: '结构体',
				kindFunction: '函数',
				kindMethod: '方法',
				kindType: '类型',
				kindVariable: '变量',
				kindField: '字段',
				kindEnum: '枚举',
				kindTrait: 'trait',
				kindImpl: 'impl',
				indexPlaceholder: 'D:\\项目路径',
				indexAction: '建立索引',
				indexHint: '可以给本机任意目录建索引，图就是这份索引画出来的。',
				tabSessions: '会话',
				sessionsHint: '这个插件回答过的每一次调用，最近的会话在前',
				session: '会话',
				workspace: '工作区',
				calls: '调用',
				lastUsed: '最近使用',
				noSessions: '还没有记录。让 agent 跑一次 code_query 或 code_verify。',
				clear: '清空',
				clearConfirm: '清空使用记录？索引本身不受影响。',
				recentCalls: '最近调用',
				openFull: '全屏打开',
				openFullHint: '在浏览器新标签页里看同一张图，空间更大',
			},
		};

		let hostCtx = null;

		function lang() {
			try {
				const snapshot = hostCtx && hostCtx.locale && hostCtx.locale.getLocale && hostCtx.locale.getLocale();
				const id = snapshot && (snapshot.locale ?? snapshot.id ?? snapshot.current ?? snapshot.lang ?? snapshot);
				if (typeof id === 'string' && id.toLowerCase().startsWith('zh')) return 'zh';
			} catch {
				/* fall through to English */
			}
			return 'en';
		}

		function t(key) {
			const table = DICT[lang()] ?? DICT.en;
			return table[key] ?? DICT.en[key] ?? key;
		}

		// ---------------------------------------------------------------------
		// data
		// ---------------------------------------------------------------------

		function apiUrl(route, params) {
			// Resolve against the origin, not document.baseURI: the app may be
			// deep-linked at /s/<id>, and a relative URL would inherit that path.
			const origin =
				typeof window !== 'undefined' && window.location && window.location.origin
					? window.location.origin
					: 'http://localhost';
			const url = new URL(`/code-impact/api/${route}`, origin);
			for (const [key, value] of Object.entries(params ?? {})) {
				if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
			}
			return url.toString();
		}

		async function getJson(url) {
			const response = await fetch(url, { headers: { accept: 'application/json' } });
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
			return body;
		}

		async function postJson(url, payload) {
			const response = await fetch(url, {
				method: 'POST',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify(payload ?? {}),
			});
			const body = await response.json().catch(() => null);
			if (!response.ok) throw new Error((body && body.error) || `HTTP ${response.status}`);
			return body;
		}

		function useOverview(root, tick) {
			const [state, setState] = useState({ loading: true, error: null, data: null });
			useEffect(() => {
				let alive = true;
				setState((prev) => ({ ...prev, loading: true, error: null }));
				getJson(apiUrl('overview', { root, refresh: tick > 0 ? 1 : '' }))
					.then((data) => {
						if (alive) setState({ loading: false, error: null, data });
					})
					.catch((error) => {
						if (alive) setState({ loading: false, error: String(error && error.message ? error.message : error), data: null });
					});
				return () => {
					alive = false;
				};
			}, [root, tick]);
			return state;
		}

		function useRoots(tick) {
			const [roots, setRoots] = useState([]);
			useEffect(() => {
				let alive = true;
				getJson(apiUrl('roots', {}))
					.then((body) => {
						if (alive && body && Array.isArray(body.roots)) setRoots(body.roots);
					})
					.catch(() => {});
				return () => {
					alive = false;
				};
			}, [tick]);
			return roots;
		}

		function useUsage(tick) {
			const [state, setState] = useState({ loading: true, error: null, data: null });
			useEffect(() => {
				let alive = true;
				setState((prev) => ({ ...prev, loading: true, error: null }));
				getJson(apiUrl('usage', { limit: 100 }))
					.then((data) => {
						if (alive) setState({ loading: false, error: null, data });
					})
					.catch((error) => {
						if (alive) setState({ loading: false, error: String(error && error.message ? error.message : error), data: null });
					});
				return () => {
					alive = false;
				};
			}, [tick]);
			return state;
		}

		function useFileDetail(root, relPath) {
			const [state, setState] = useState({ loading: false, error: null, data: null });
			useEffect(() => {
				if (!relPath) {
					setState({ loading: false, error: null, data: null });
					return undefined;
				}
				let alive = true;
				setState({ loading: true, error: null, data: null });
				getJson(apiUrl('file', { root, path: relPath }))
					.then((data) => {
						if (alive) setState({ loading: false, error: null, data });
					})
					.catch((error) => {
						if (alive) setState({ loading: false, error: String(error && error.message ? error.message : error), data: null });
					});
				return () => {
					alive = false;
				};
			}, [root, relPath]);
			return state;
		}

		// ---------------------------------------------------------------------
		// shared bits
		// ---------------------------------------------------------------------

		const LANG_FILL = {
			ts: 'var(--dsw-alias-brand-primary)',
			js: 'var(--dsw-alias-state-warn-primary)',
			go: 'var(--dsw-alias-state-success-primary)',
		};

		function langColor(l) {
			return LANG_FILL[l] ?? 'var(--dsw-alias-label-secondary)';
		}

		function shortPath(p) {
			const parts = String(p).split('/');
			return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
		}

		function fit(text, width, size) {
			const max = Math.max(3, Math.floor(width / ((size ?? 10) * 0.62)));
			const value = String(text);
			return value.length <= max ? value : `${value.slice(0, Math.max(1, max - 1))}…`;
		}

		function chip(label, value, color) {
			return h(
				'div',
				{
					key: label,
					style: {
						display: 'flex',
						gap: 6,
						alignItems: 'baseline',
						padding: '3px 9px',
						borderRadius: 999,
						border: '1px solid var(--dsw-alias-border-l1)',
						background: 'var(--dsw-alias-bg-layer-1)',
						fontSize: 12,
						whiteSpace: 'nowrap',
					},
				},
				h('span', { style: { color: 'var(--dsw-alias-label-secondary)' } }, label),
				h('span', { style: { color: color ?? 'var(--dsw-alias-label-primary)', fontVariantNumeric: 'tabular-nums' } }, String(value)),
			);
		}

		function button(label, onClick, options) {
			const opts = options ?? {};
			return h(
				'button',
				{
					key: opts.key,
					type: 'button',
					onClick,
					disabled: opts.disabled,
					style: {
						appearance: 'none',
						border: '1px solid var(--dsw-alias-border-l1)',
						background: opts.active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
						color: opts.active ? 'var(--dsw-alias-bg-base)' : 'var(--dsw-alias-label-primary)',
						borderRadius: 8,
						padding: '5px 12px',
						fontSize: 12,
						fontWeight: 500,
						cursor: opts.disabled ? 'default' : 'pointer',
						opacity: opts.disabled ? 0.5 : 1,
					},
				},
				label,
			);
		}

		function ageText(ms) {
			if (ms === null || ms === undefined) return '—';
			const seconds = Math.round(ms / 1000);
			if (seconds < 60) return `${seconds}s`;
			const minutes = Math.round(seconds / 60);
			if (minutes < 60) return `${minutes}m`;
			const hours = Math.round(minutes / 60);
			if (hours < 24) return `${hours}h`;
			return `${Math.round(hours / 24)}d`;
		}

		// ---------------------------------------------------------------------
		// architecture: a directory/file treemap
		// ---------------------------------------------------------------------

		function buildTree(files) {
			const root = { name: '', path: '', children: new Map(), size: 0, dir: true };
			for (const file of files) {
				const parts = String(file.p).split('/');
				let node = root;
				node.size += Math.max(1, file.n);
				for (let i = 0; i < parts.length - 1; i += 1) {
					const key = parts[i];
					let next = node.children.get(key);
					if (!next) {
						next = { name: key, path: parts.slice(0, i + 1).join('/'), children: new Map(), size: 0, dir: true };
						node.children.set(key, next);
					}
					node = next;
					node.size += Math.max(1, file.n);
				}
				node.children.set(parts[parts.length - 1], {
					name: parts[parts.length - 1],
					path: file.p,
					children: new Map(),
					size: Math.max(1, file.n),
					file,
					dir: false,
				});
			}
			return root;
		}

		/** Alternating slice layout: at even depth a node splits into columns, at odd depth into rows. */
		function sliceLayout(node, rect, depth, out) {
			const kids = [...node.children.values()].sort((a, b) => b.size - a.size);
			if (kids.length === 0) {
				out.push({ rect, node });
				return;
			}
			const total = kids.reduce((sum, kid) => sum + kid.size, 0) || 1;
			const columns = depth % 2 === 0;
			let offset = 0;
			for (const kid of kids) {
				const fraction = kid.size / total;
				const cell = columns
					? { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * fraction, h: rect.h }
					: { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * fraction };
				offset += fraction;
				if (kid.children.size === 0) out.push({ rect: cell, node: kid });
				else sliceLayout(kid, cell, depth + 1, out);
			}
		}

		const GRAPH_W = 1000;
		const GRAPH_H = 560;

		function ArchitectureView({ data, selected, onSelect }) {
			const cells = useMemo(() => {
				const tree = buildTree(data.files);
				const out = [];
				sliceLayout(tree, { x: 4, y: 4, w: GRAPH_W - 8, h: GRAPH_H - 8 }, 0, out);
				return out;
			}, [data]);

			return h(
				'svg',
				{
					viewBox: `0 0 ${GRAPH_W} ${GRAPH_H}`,
					preserveAspectRatio: 'xMidYMid meet',
					style: { width: '100%', height: 'auto', display: 'block' },
					role: 'img',
				},
				...cells.map(({ rect, node }) => {
					const isFile = !node.dir;
					const active = isFile && selected && selected.kind === 'file' && selected.path === node.path;
					const color = isFile ? langColor(node.file.l) : 'var(--dsw-alias-border-l1)';
					const stroke = active ? 'var(--dsw-alias-brand-primary)' : isFile ? color : 'var(--dsw-alias-border-l1)';
					const label = node.name;
					const showLabel = rect.w > 46 && rect.h > 15;
					const children = [
						h('rect', {
							key: 'r',
							x: rect.x,
							y: rect.y,
							width: Math.max(0, rect.w - 1.5),
							height: Math.max(0, rect.h - 1.5),
							rx: isFile ? 3 : 5,
							fill: isFile ? color : 'var(--dsw-alias-bg-base)',
							fillOpacity: isFile ? (active ? 0.42 : 0.18) : 0.35,
							stroke,
							strokeWidth: active ? 1.8 : 0.8,
							strokeOpacity: isFile ? 0.75 : 0.6,
						}),
					];
					if (showLabel) {
						children.push(
							h(
								'text',
								{
									key: 't',
									x: rect.x + 5,
									y: rect.y + (isFile ? 13 : 14),
									fontSize: isFile ? 10 : 11,
									fontWeight: isFile ? 400 : 600,
									fill: isFile ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
									pointerEvents: 'none',
								},
								fit(label, rect.w - 10, isFile ? 10 : 11),
							),
						);
					}
					return h(
						'g',
						{
							key: node.path || label,
							onClick: isFile ? () => onSelect({ kind: 'file', path: node.path }) : undefined,
							style: { cursor: isFile ? 'pointer' : 'default' },
						},
						...children,
						h('title', null, isFile ? `${node.path} — ${node.file.n} ${t('symbols')}` : `${node.path || '/'} — ${node.size} ${t('symbols')}`),
					);
				}),
			);
		}

		// ---------------------------------------------------------------------
		// imports: a circular graph, grouped by directory
		// ---------------------------------------------------------------------

		const MAX_IMPORT_NODES = 260;

		function ImportView({ data, selected, onSelect }) {
			const [hover, setHover] = useState(null);

			const model = useMemo(() => {
				const files = data.files.slice().sort((a, b) => String(a.p).localeCompare(String(b.p)));
				const kept = files.slice(0, MAX_IMPORT_NODES);
				const keptSet = new Set(kept.map((file) => file.p));
				const groups = new Map();
				for (const file of kept) {
					const dir = String(file.p).includes('/') ? String(file.p).slice(0, String(file.p).lastIndexOf('/')) : '.';
					if (!groups.has(dir)) groups.set(dir, []);
					groups.get(dir).push(file);
				}
				const cx = GRAPH_W / 2;
				const cy = GRAPH_H / 2;
				const radius = Math.min(GRAPH_W, GRAPH_H) / 2 - 46;
				const order = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
				const gap = order.length > 1 ? Math.min(0.05, 0.6 / order.length) : 0;
				const usable = Math.PI * 2 - gap * order.length;
				const nodes = new Map();
				const dirLabels = [];
				let angle = -Math.PI / 2;
				for (const [dir, members] of order) {
					const span = (usable * members.length) / kept.length;
					const step = members.length > 0 ? span / members.length : 0;
					for (let i = 0; i < members.length; i += 1) {
						const a = angle + step * (i + 0.5);
						const file = members[i];
						nodes.set(file.p, {
							...file,
							angle: a,
							x: cx + Math.cos(a) * radius,
							y: cy + Math.sin(a) * radius,
							r: Math.max(3, Math.min(9, 2.5 + Math.sqrt(file.n) * 0.7)),
						});
					}
					const mid = angle + span / 2;
					if (span > 0.18) {
						dirLabels.push({
							dir: dir === '.' ? '/' : dir,
							x: cx + Math.cos(mid) * (radius + 26),
							y: cy + Math.sin(mid) * (radius + 26),
							anchor: Math.cos(mid) >= 0 ? 'start' : 'end',
							n: members.length,
						});
					}
					angle += span + gap;
				}
				const edges = [];
				for (const file of kept) {
					const from = nodes.get(file.p);
					if (!from) continue;
					for (const target of file.i ?? []) {
						const to = nodes.get(target);
						if (!to) continue;
						const mx = (from.x + to.x) / 2;
						const my = (from.y + to.y) / 2;
						const dx = to.x - from.x;
						const dy = to.y - from.y;
						const bow = 0.14;
						edges.push({
							key: `${file.p}>${target}`,
							from: file.p,
							to: target,
							d: `M ${from.x.toFixed(1)} ${from.y.toFixed(1)} Q ${(mx - dy * bow).toFixed(1)} ${(my + dx * bow).toFixed(1)} ${to.x.toFixed(1)} ${to.y.toFixed(1)}`,
						});
					}
				}
				return { nodes, dirLabels, edges, cx, cy, truncated: data.files.length > kept.length, kept: keptSet };
			}, [data]);

			const focus = hover ?? (selected && selected.kind === 'file' ? selected.path : null);
			const related = useMemo(() => {
				if (!focus) return null;
				const set = new Set([focus]);
				for (const edge of model.edges) {
					if (edge.from === focus) set.add(edge.to);
					if (edge.to === focus) set.add(edge.from);
				}
				return set;
			}, [focus, model]);

			return h(
				'svg',
				{
					viewBox: `0 0 ${GRAPH_W} ${GRAPH_H}`,
					preserveAspectRatio: 'xMidYMid meet',
					style: { width: '100%', height: 'auto', display: 'block' },
					role: 'img',
					onMouseLeave: () => setHover(null),
				},
				h('defs', null,
					h('marker', {
						id: 'ci-arrow',
						viewBox: '0 0 8 8',
						refX: 7,
						refY: 3,
						markerWidth: 5,
						markerHeight: 5,
						orient: 'auto',
					}, h('path', { d: 'M 0 0 L 8 3 L 0 6 z', fill: 'var(--dsw-alias-border-l2)' })),
				),
				...model.edges.map((edge) => {
					const dim = related ? !(related.has(edge.from) && related.has(edge.to)) : false;
					const hot = focus ? edge.from === focus || edge.to === focus : false;
					return h('path', {
						key: edge.key,
						d: edge.d,
						fill: 'none',
						stroke: hot ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
						strokeOpacity: dim ? 0.05 : hot ? 0.85 : 0.28,
						strokeWidth: hot ? 1.6 : 0.9,
						markerEnd: 'url(#ci-arrow)',
					});
				}),
				...model.dirLabels.map((label) =>
					h(
						'text',
						{
							key: `dir:${label.dir}`,
							x: label.x,
							y: label.y,
							fontSize: 10,
							textAnchor: label.anchor,
							fill: 'var(--dsw-alias-label-secondary)',
							pointerEvents: 'none',
						},
						fit(label.dir, 150, 10),
					),
				),
				...[...model.nodes.values()].map((node) => {
					const active = selected && selected.kind === 'file' && selected.path === node.p;
					const dim = related ? !related.has(node.p) : false;
					return h(
						'g',
						{
							key: node.p,
							onMouseEnter: () => setHover(node.p),
							onClick: () => onSelect({ kind: 'file', path: node.p }),
							style: { cursor: 'pointer' },
						},
						h('circle', {
							cx: node.x,
							cy: node.y,
							r: node.r + (active || hot(node.p, focus) ? 2.5 : 0),
							fill: langColor(node.l),
							fillOpacity: dim ? 0.18 : active || hot(node.p, focus) ? 0.95 : 0.6,
							stroke: active ? 'var(--dsw-alias-label-primary)' : 'transparent',
							strokeWidth: 1.2,
						}),
						h('title', null, `${node.p} — ${node.n} ${t('symbols')}`),
					);
				}),
			);
		}

		function hot(path, focus) {
			return focus === path;
		}

		// ---------------------------------------------------------------------
		// inheritance: a layered DAG
		// ---------------------------------------------------------------------

		const NODE_W = 158;
		const NODE_H = 40;
		const COL_W = 236;
		const ROW_H = 58;

		function TypeView({ data, selected, onSelect }) {
			const layout = useMemo(() => {
				const types = data.types ?? [];
				const byName = new Map();
				for (const type of types) {
					if (!byName.has(type.n)) byName.set(type.n, []);
					byName.get(type.n).push(type);
				}
				const depthOf = new Map();
				const visiting = new Set();
				function depth(type) {
					if (depthOf.has(type.id)) return depthOf.get(type.id);
					if (visiting.has(type.id)) return 0; // a cycle: call it a root rather than hang
					visiting.add(type.id);
					let best = 0;
					for (const name of type.sup ?? []) {
						for (const parent of byName.get(name) ?? []) {
							if (parent.id === type.id) continue;
							best = Math.max(best, depth(parent) + 1);
						}
					}
					visiting.delete(type.id);
					depthOf.set(type.id, best);
					return best;
				}
				for (const type of types) depth(type);

				const columns = new Map();
				for (const type of types) {
					const d = depthOf.get(type.id) ?? 0;
					if (!columns.has(d)) columns.set(d, []);
					columns.get(d).push(type);
				}
				const maxDepth = columns.size === 0 ? 0 : Math.max(...columns.keys());
				const nodes = new Map();
				let tallest = 0;
				for (const [d, members] of columns) {
					members.sort((a, b) => String(a.n).localeCompare(String(b.n)));
					tallest = Math.max(tallest, members.length);
					members.forEach((type, index) => {
						nodes.set(type.id, {
							type,
							x: 30 + d * COL_W,
							y: 30 + index * ROW_H,
						});
					});
				}
				const width = Math.max(GRAPH_W, 30 + (maxDepth + 1) * COL_W + 40);
				const height = Math.max(320, 40 + tallest * ROW_H);
				const edges = [];
				for (const type of types) {
					const child = nodes.get(type.id);
					if (!child) continue;
					const seen = new Set();
					for (const name of type.sup ?? []) {
						for (const parent of byName.get(name) ?? []) {
							if (parent.id === type.id || seen.has(parent.id)) continue;
							seen.add(parent.id);
							const p = nodes.get(parent.id);
							if (!p) continue;
							const kind = type.hk?.[type.sup.indexOf(name)] ?? 'extends';
							const x1 = child.x;
							const y1 = child.y + NODE_H / 2;
							const x2 = p.x + NODE_W;
							const y2 = p.y + NODE_H / 2;
							edges.push({
								key: `${type.id}>${parent.id}`,
								kind,
								child: type.id,
								parent: parent.id,
								d: `M ${x1} ${y1} C ${x1 - 40} ${y1}, ${x2 + 40} ${y2}, ${x2} ${y2}`,
							});
						}
					}
				}
				return { nodes, edges, width, height, maxDepth };
			}, [data]);

			if ((data.types ?? []).length === 0) return h(Empty, { text: t('typesEmpty') });

			const focusId = selected && selected.kind === 'type' ? selected.id : null;

			return h(
				'svg',
				{
					viewBox: `0 0 ${layout.width} ${layout.height}`,
					preserveAspectRatio: 'xMinYMin meet',
					style: { width: '100%', height: 'auto', display: 'block' },
					role: 'img',
				},
				...layout.edges.map((edge) => {
					const hot = focusId && (edge.child === focusId || edge.parent === focusId);
					const dashed = edge.kind === 'implements';
					return h('path', {
						key: edge.key,
						d: edge.d,
						fill: 'none',
						stroke: hot ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
						strokeOpacity: hot ? 0.9 : 0.45,
						strokeWidth: hot ? 1.7 : 1,
						strokeDasharray: dashed ? '4 3' : undefined,
					});
				}),
				...[...layout.nodes.values()].map(({ type, x, y }) => {
					const active = focusId === type.id;
					return h(
						'g',
						{
							key: type.id,
							onClick: () => onSelect({ kind: 'type', id: type.id, type }),
							style: { cursor: 'pointer' },
						},
						h('rect', {
							x,
							y,
							width: NODE_W,
							height: NODE_H,
							rx: 7,
							fill: 'var(--dsw-alias-bg-layer-1)',
							stroke: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)',
							strokeWidth: active ? 1.8 : 1,
						}),
						h('rect', { x, y, width: 3.5, height: NODE_H, rx: 2, fill: langColor('ts') }),
						h(
							'text',
							{ x: x + 11, y: y + 16, fontSize: 11, fill: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
							fit(type.n, NODE_W - 22, 11),
						),
						h(
							'text',
							{ x: x + 11, y: y + 30, fontSize: 9.5, fill: 'var(--dsw-alias-label-secondary)' },
							`${t(`kind${type.k[0].toUpperCase()}${type.k.slice(1)}`)} · ${shortPath(type.p)}`,
						),
						h('title', null, `${type.n} (${type.k}) — ${type.p}:${type.l}`),
					);
				}),
			);
		}

		// ---------------------------------------------------------------------
		// detail panel
		// ---------------------------------------------------------------------

		const KIND_BADGE = {
			class: 'C',
			interface: 'I',
			struct: 'S',
			function: 'ƒ',
			method: 'm',
			type: 'T',
			variable: 'v',
			field: 'f',
			enum: 'E',
			trait: 'Tr',
			impl: 'Im',
			namespace: 'N',
			module: 'M',
		};

		function DetailFile({ root, path }) {
			const { data, error, loading } = useFileDetail(root, path);
			const groups = useMemo(() => {
				if (!data) return null;
				const symbols = data.symbols ?? [];
				const exported = symbols.filter((symbol) => symbol.x);
				const internal = symbols.filter((symbol) => !symbol.x);
				return { exported, internal };
			}, [data]);

			if (loading) return h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('loading'));
			if (error) return h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 } }, error);
			if (!data) return null;

			const row = (symbol) =>
				h(
					'div',
					{
						key: `${symbol.k}:${symbol.q}:${symbol.l}`,
						style: {
							display: 'flex',
							gap: 7,
							alignItems: 'baseline',
							padding: '3px 0',
							borderBottom: '1px solid var(--dsw-alias-border-l1)',
						},
					},
					h(
						'span',
						{
							style: {
								flex: '0 0 20px',
								fontSize: 9,
								fontWeight: 600,
								color: 'var(--dsw-alias-label-secondary)',
								textAlign: 'center',
								border: '1px solid var(--dsw-alias-border-l1)',
								borderRadius: 4,
							},
						},
						KIND_BADGE[symbol.k] ?? '·',
					),
					h(
						'div',
						{ style: { minWidth: 0, flex: 1 } },
						h(
							'div',
							{
								style: {
									fontSize: 12,
									color: 'var(--dsw-alias-label-primary)',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									whiteSpace: 'nowrap',
								},
								title: symbol.s || symbol.q,
							},
							symbol.q,
						),
						symbol.s
							? h(
									'div',
									{
										style: {
											fontSize: 10,
											color: 'var(--dsw-alias-label-secondary)',
											overflow: 'hidden',
											textOverflow: 'ellipsis',
											whiteSpace: 'nowrap',
										},
									},
									symbol.s,
								)
							: null,
					),
					h('span', { style: { fontSize: 10, color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums' } }, `:${symbol.l}`),
				);

			return h(
				'div',
				null,
				h('div', { style: { fontSize: 12, fontWeight: 600, marginBottom: 2, wordBreak: 'break-all' } }, data.path),
				h(
					'div',
					{ style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 10 } },
					`${data.lang} · ${(data.symbols ?? []).length} ${t('symbols')} · ${(data.imports ?? []).length} imports`,
				),
				groups && groups.exported.length > 0
					? h('div', { style: { marginBottom: 10 } },
							h('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, t('exports')),
							...groups.exported.map(row),
						)
					: null,
				groups && groups.internal.length > 0
					? h('div', null,
							h('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, t('notExported')),
							...groups.internal.map(row),
						)
					: null,
				(data.symbols ?? []).length === 0
					? h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('noSymbols'))
					: null,
			);
		}

		function DetailType({ type, onOpenFile }) {
			const open = type.p ? h(
				'button',
				{
					type: 'button',
					onClick: () => onOpenFile(type.p),
					style: {
						marginTop: 4,
						appearance: 'none',
						border: '1px solid var(--dsw-alias-border-l1)',
						background: 'transparent',
						color: 'var(--dsw-alias-brand-primary)',
						borderRadius: 6,
						padding: '3px 8px',
						fontSize: 11,
						cursor: 'pointer',
					},
				},
				t('openFile'),
			) : null;

			const list = (title, values) =>
				values && values.length > 0
					? h('div', { style: { marginTop: 10 } },
							h('div', { style: { fontSize: 11, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', marginBottom: 4 } }, title),
							...values.map((value) =>
								h('div', { key: value, style: { fontSize: 11, color: 'var(--dsw-alias-label-primary)', padding: '2px 0' } }, value),
							),
						)
					: null;

			return h(
				'div',
				null,
				h('div', { style: { fontSize: 13, fontWeight: 600, wordBreak: 'break-all' } }, type.n),
				h('div', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, `${type.k} · ${type.p}:${type.l}`),
				open,
				list(t('sups'), (type.sup ?? []).map((name, index) => `${type.hk?.[index] ?? 'extends'} ${name}`)),
				list(t('subs'), type.sub ?? []),
			);
		}

		// ---------------------------------------------------------------------
		// page
		// ---------------------------------------------------------------------

		function Empty({ text }) {
			return h(
				'div',
				{
					style: {
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						height: 220,
						color: 'var(--dsw-alias-label-secondary)',
						fontSize: 13,
						border: '1px dashed var(--dsw-alias-border-l1)',
						borderRadius: 10,
					},
				},
				text,
			);
		}

		function UsageView({ data, onSelect, selected }) {
			if (!data) return h(Empty, { text: t('loading') });
			if (!data.sessions || data.sessions.length === 0) return h(Empty, { text: t('noSessions') });
			const head = ['session', 'workspace', 'calls', 'lastUsed'];
			return h(
				'div',
				{ style: { fontSize: 12 } },
				h(
					'div',
					{ style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)', marginBottom: 8 } },
					`${data.totals.sessions} ${t('session')} · ${data.totals.calls} ${t('calls')}`,
				),
				h(
					'table',
					{ style: { width: '100%', borderCollapse: 'collapse' } },
					h(
						'thead',
						{},
						h(
							'tr',
							{},
							...head.map((key) =>
								h(
									'th',
									{
										key,
										style: {
											textAlign: 'left',
											fontWeight: 500,
											fontSize: 10,
											textTransform: 'uppercase',
											letterSpacing: '0.5px',
											color: 'var(--dsw-alias-label-secondary)',
											padding: '4px 6px',
											borderBottom: '1px solid var(--dsw-alias-border-l1)',
										},
									},
									t(key),
								),
							),
						),
					),
					h(
						'tbody',
						{},
						...data.sessions.map((session) => {
							const active = selected && selected.kind === 'session' && selected.session.id === session.id;
							const calls = Object.entries(session.calls || {})
								.map(([tool, n]) => `${tool} ${n}`)
								.join(' · ');
							return h(
								'tr',
								{
									key: session.id,
									onClick: () => onSelect({ kind: 'session', session }),
									style: {
										cursor: 'pointer',
										background: active ? 'color-mix(in oklab, var(--dsw-alias-brand-primary) 10%, transparent)' : 'transparent',
									},
								},
								h('td', { style: { padding: '5px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, h('code', { style: { fontSize: 11 } }, session.id)),
								h(
									'td',
									{ style: { padding: '5px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', wordBreak: 'break-all' } },
									session.cwd ? shortPath(session.cwd.replace(/\\/g, '/')) : '—',
								),
								h('td', { style: { padding: '5px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)' } }, calls || '—'),
								h(
									'td',
									{ style: { padding: '5px 6px', borderBottom: '1px solid var(--dsw-alias-border-l1)', color: 'var(--dsw-alias-label-secondary)', whiteSpace: 'nowrap' } },
									ageText(Date.now() - session.lastAt),
								),
							);
						}),
					),
				),
			);
		}

		function DetailSession({ session }) {
			return h(
				'div',
				{ style: { fontSize: 12 } },
				h('div', { style: { fontWeight: 600, wordBreak: 'break-all' } }, session.id),
				h('div', { style: { color: 'var(--dsw-alias-label-secondary)', marginTop: 2, wordBreak: 'break-all' } }, session.cwd || '—'),
				h(
					'div',
					{ style: { color: 'var(--dsw-alias-label-secondary)', marginTop: 6 } },
					`${t('calls')}: ${Object.entries(session.calls || {}).map(([tool, n]) => `${tool} ${n}`).join(' · ') || '—'}`,
				),
				h('div', { style: { marginTop: 10, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.5px', color: 'var(--dsw-alias-label-secondary)' } }, t('recentCalls')),
				...session.events.map((event, index) =>
					h(
						'div',
						{
							key: `${event.at}-${index}`,
							style: {
								display: 'flex',
								gap: 8,
								padding: '4px 0',
								borderBottom: '1px solid var(--dsw-alias-border-l1)',
								alignItems: 'baseline',
							},
						},
						h('span', { style: { color: 'var(--dsw-alias-label-secondary)', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' } }, new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
						h(
							'div',
							{ style: { minWidth: 0 } },
							h('div', {}, `${event.tool}${event.op ? ` ${event.op}` : ''}`),
							event.target ? h('code', { style: { fontSize: 11, wordBreak: 'break-all' } }, event.target) : null,
							h('div', { style: { color: 'var(--dsw-alias-label-secondary)' } }, event.outcome || ''),
						),
					),
				),
			);
		}

		function CodeImpactPage() {
			const [root, setRoot] = useState(null);
			const [tick, setTick] = useState(0);
			const [tab, setTab] = useState('architecture');
			const [selected, setSelected] = useState(null);
			const roots = useRoots(tick);
			const { data, error, loading } = useOverview(root, tick);
			const usage = useUsage(tick);

			const activeRoot = root ?? (data && data.root) ?? null;

			const [pathInput, setPathInput] = useState('');
			const [indexing, setIndexing] = useState(false);
			const [indexError, setIndexError] = useState(null);
			const [indexNote, setIndexNote] = useState(null);

			const submitIndex = useCallback(() => {
				const target = pathInput.trim();
				if (!target || indexing) return;
				setIndexing(true);
				setIndexError(null);
				setIndexNote(null);
				postJson(apiUrl('index'), { root: target })
					.then((added) => {
						setPathInput('');
						setRoot(added.root);
						setSelected(null);
						setTick((value) => value + 1);
						setIndexNote(`${added.files} files · ${added.symbols} symbols`);
					})
					.catch((failure) => setIndexError(String(failure && failure.message ? failure.message : failure)))
					.finally(() => setIndexing(false));
			}, [pathInput, indexing]);

			const onSelect = useCallback((value) => {
				setSelected(value);
			}, []);

			const body = (() => {
				if (tab === 'sessions') {
					return h(UsageView, { data: usage.data, onSelect, selected });
				}
				if (error) {
					return h(
						'div',
						{ style: { padding: 24, textAlign: 'center' } },
						h('div', { style: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 13, marginBottom: 8 } }, t('failed')),
						h('div', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, marginBottom: 12, wordBreak: 'break-word' } }, error),
						button(t('retry'), () => setTick((value) => value + 1)),
					);
				}
				if (loading && !data) {
					return h('div', { style: { padding: 24, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 } }, t('loading'));
				}
				if (!data) return null;
				if (data.status.files === 0) {
					return h(
						'div',
						{ style: { padding: 24, textAlign: 'center' } },
						h('div', { style: { fontSize: 13, marginBottom: 6 } }, t('empty')),
						h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('emptyHint')),
					);
				}
				if (tab === 'imports') {
					if ((data.edges ?? []).length === 0) return h(Empty, { text: t('importsEmpty') });
					return h(ImportView, { data, selected, onSelect });
				}
				if (tab === 'types') return h(TypeView, { data, selected, onSelect });
				return h(ArchitectureView, { data, selected, onSelect });
			})();

			const header = data
				? h(
						'div',
						{ style: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 } },
						chip(t('files'), data.status.files),
						chip(t('symbols'), data.status.symbols),
						chip(t('names'), data.status.names),
						data.status.langs
							? chip(
									'langs',
									Object.entries(data.status.langs)
										.filter(([, count]) => count > 0)
										.map(([name, count]) => `${name} ${count}`)
										.join(' · '),
								)
							: null,
						chip(t('updated'), ageText(data.status.ageMs)),
						data.truncated ? chip('graph', t('truncated'), 'var(--dsw-alias-state-warn-primary)') : null,
						data.status.skipped > 0
							? chip(`${data.status.skipped}`, t('skipped'), 'var(--dsw-alias-state-warn-primary)')
							: null,
					)
				: null;

			const tabs = [
				['architecture', t('tabArchitecture')],
				['imports', t('tabImports')],
				['types', t('tabTypes')],
				['sessions', t('tabSessions')],
			];

			const detail = (() => {
				if (!selected) {
					return h('div', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, t('selectHint'));
				}
				if (selected.kind === 'session') {
					return h(DetailSession, { session: selected.session });
				}
				if (selected.kind === 'type') {
					return h(DetailType, { type: selected.type, onOpenFile: (path) => setSelected({ kind: 'file', path }) });
				}
				if (selected.kind === 'file') {
					return h(DetailFile, { root: activeRoot, path: selected.path });
				}
				return null;
			})();

			return h(
				'div',
				{
					style: {
						display: 'flex',
						flexDirection: 'column',
						gap: 10,
						padding: '4px 2px 18px',
						color: 'var(--dsw-alias-label-primary)',
					},
				},
				h(
					'div',
					{ style: { display: 'flex', alignItems: 'flex-start', gap: 12, flexWrap: 'wrap' } },
					h(
						'div',
						{ style: { minWidth: 220, flex: 1 } },
						h('div', { style: { fontSize: 15, fontWeight: 600 } }, t('title')),
						h(
							'div',
							{ style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', marginTop: 2, wordBreak: 'break-all' } },
							activeRoot ?? t('subtitle'),
						),
					),
					h(
						'div',
						{ style: { display: 'flex', gap: 6, alignItems: 'center' } },
						roots.length > 1
							? h(
									'select',
									{
										value: activeRoot ?? '',
										onChange: (event) => {
											setRoot(event.target.value);
											setSelected(null);
										},
										style: {
											maxWidth: 280,
											fontSize: 11,
											padding: '4px 6px',
											borderRadius: 7,
											border: '1px solid var(--dsw-alias-border-l1)',
											background: 'var(--dsw-alias-bg-layer-1)',
											color: 'var(--dsw-alias-label-primary)',
										},
									},
									...roots.map((entry) =>
										h('option', { key: entry.root, value: entry.root }, shortPath(entry.root.replace(/\\/g, '/'))),
									),
								)
							: null,
						button(loading ? '…' : t('refresh'), () => setTick((value) => value + 1), { disabled: loading }),
						button(t('openFull'), () => {
							window.open('/code-impact/app', '_blank', 'noopener');
						}, { title: t('openFullHint') }),
					),
				),
				header,
				h(
					'div',
					{ style: { display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' } },
					h('input', {
						value: pathInput,
						placeholder: t('indexPlaceholder'),
						'aria-label': t('indexAction'),
						onChange: (event) => setPathInput(event.target.value),
						onKeyDown: (event) => {
							if (event.key === 'Enter') submitIndex();
						},
						style: {
							flex: '1 1 260px',
							minWidth: 180,
							maxWidth: 420,
							fontSize: 11,
							padding: '5px 8px',
							borderRadius: 7,
							border: '1px solid var(--dsw-alias-border-l1)',
							background: 'var(--dsw-alias-bg-layer-1)',
							color: 'var(--dsw-alias-label-primary)',
						},
					}),
					button(indexing ? '…' : t('indexAction'), submitIndex, { disabled: indexing }),
					indexError
						? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-error-primary)', wordBreak: 'break-word' } }, indexError)
						: null,
					indexNote
						? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-state-success-primary)' } }, indexNote)
						: null,
					h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, t('indexHint')),
				),
				h(
					'div',
					{ style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
					...tabs.map(([id, label]) => button(label, () => setTab(id), { key: id, active: tab === id })),
				),
				h(
					'div',
					{
						style: {
							marginTop: 2,
							fontSize: 11,
							color: 'var(--dsw-alias-label-secondary)',
						},
					},
					tab === 'architecture'
						? t('architectureHint')
						: tab === 'imports'
							? t('importsHint')
							: tab === 'sessions'
								? t('sessionsHint')
								: t('typesHint'),
				),
				h(
					'div',
					{
						style: {
							display: 'flex',
							gap: 12,
							alignItems: 'flex-start',
							flexWrap: 'wrap',
						},
					},
					h(
						'div',
						{
							style: {
								flex: '1 1 620px',
								minWidth: 320,
								padding: 8,
								borderRadius: 12,
								border: '1px solid var(--dsw-alias-border-l1)',
								background: 'var(--dsw-alias-bg-layer-1)',
							},
						},
						body,
					),
					h(
						'div',
						{
							style: {
								flex: '0 1 320px',
								minWidth: 240,
								padding: 12,
								borderRadius: 12,
								border: '1px solid var(--dsw-alias-border-l1)',
								background: 'var(--dsw-alias-bg-layer-1)',
								maxHeight: 620,
								overflow: 'auto',
							},
						},
						detail,
					),
				),
			);
		}

		// ---------------------------------------------------------------------

		return {
			inject: ['slots'],
			apply(ctx) {
				hostCtx = ctx;
				try {
					ctx.effect(() => ctx.locale.register('dsh-code-impact', 'en', DICT.en));
					ctx.effect(() => ctx.locale.register('dsh-code-impact', 'zh', DICT.zh));
				} catch {
					/* the page falls back to its built-in strings */
				}
				ctx.slots.inject('settings.section', () =>
					ctx.slots.register(
						{
							name: 'settings.section',
							id: 'code-impact',
							order: 25,
							label: () => t('title'),
						},
						CodeImpactPage,
					),
				);
			},
		};
	},
});
