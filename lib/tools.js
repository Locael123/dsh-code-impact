/**
 * The model-facing surface. Two tools, not seven: the op discriminator keeps the
 * tool list short, and every answer is bounded and line-addressable so it can be
 * checked instead of trusted.
 */

const MAX_TEXT = 240;

function text(value) {
	return [{ type: 'text', text: value }];
}

function clip(value, max = MAX_TEXT) {
	const s = String(value ?? '');
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function fmtFind(result) {
	const lines = [];
	const mode = result.mode === 'fuzzy' && result.total > 0 ? ' (fuzzy: no exact name match)' : '';
	lines.push(`find "${result.query}" — ${result.total} match${result.total === 1 ? '' : 'es'}${mode}`);
	for (const match of result.matches) {
		lines.push('');
		lines.push(`${match.id}`);
		lines.push(`  ${match.kind}  ${match.path}:${match.line}-${match.endLine}  ${match.exported ? 'exported' : 'internal'}  refs:${match.refs}`);
		if (match.sig) lines.push(`  ${clip(match.sig, 180)}`);
	}
	if (result.truncated) lines.push(`\n…${result.total - result.matches.length} more not shown (narrow with kind/path_filter or raise limit)`);
	if (result.total === 0) lines.push('no symbol by that name; try op=search for a substring match');
	return lines.join('\n');
}

function fmtOutline(result) {
	if (result.candidates) {
		if (result.candidates.length === 0) return `no indexed file matches "${result.path}"`;
		return `no indexed file matches "${result.path}". Did you mean:\n${result.candidates.map((c) => `  ${c}`).join('\n')}`;
	}
	const lines = [`outline ${result.path} — ${result.total} declarations (${result.lang})`];
	for (const item of result.items) {
		const indent = '  '.repeat(item.depth + 1);
		const tag = item.exported ? '' : ' ·';
		lines.push(`${indent}${item.line}-${item.endLine} ${item.kind} ${item.qual}${tag}${item.heritage ? `  ${item.heritage}` : ''}`);
		if (item.sig && item.kind !== 'class' && item.kind !== 'interface') lines.push(`${indent}    ${clip(item.sig, 140)}`);
	}
	if (result.truncated) lines.push(`…${result.total - result.items.length} more`);
	return lines.join('\n');
}

function fmtRefs(result) {
	if (result.error) return result.error;
	const t = result.target;
	const lines = [
		`refs ${t.id} — ${result.total} site${result.total === 1 ? '' : 's'} (${t.exported ? 'exported' : 'internal'}, refs:${t.refs})`,
		`  ${t.kind} ${t.path}:${t.line}  ${clip(t.sig, 140)}`,
	];
	const byConfidence = { exact: 0, resolved: 0, heuristic: 0, ambiguous: 0 };
	for (const site of result.sites) byConfidence[site.confidence] = (byConfidence[site.confidence] ?? 0) + 1;
	lines.push(`  confidence: exact ${byConfidence.exact} · resolved ${byConfidence.resolved} · heuristic ${byConfidence.heuristic} · unresolved mentions ${result.unresolved}`);
	lines.push('');
	for (const site of result.sites) {
		lines.push(`${site.path}:${site.line}  ${site.role}  ${site.owner ? `in ${site.owner}` : ''}${site.confidence !== 'exact' ? `  (${site.confidence})` : ''}`);
		if (site.text) lines.push(`    ${clip(site.text, 160)}`);
	}
	if (result.truncated) lines.push(`…truncated after ${result.sites.length} sites (${result.candidates} mentions of the name were candidates)`);
	if (result.sites.length === 0) lines.push('no references found — the symbol may be new, or used only through dynamic access');
	return lines.join('\n');
}

function fmtHierarchy(result) {
	if (result.error) return result.error;
	const t = result.target;
	const lines = [`hierarchy ${t.id} — ${t.kind} ${t.path}:${t.line}`];
	if (result.supers.length > 0) {
		lines.push('', 'extends / implements:');
		for (const s of result.supers) {
			const target = s.resolved ? s.resolved.id : `${s.name} (${s.confidence})`;
			lines.push(`  ${s.kind} ${target}  line ${s.line}`);
		}
	}
	if (result.subs.length > 0) {
		lines.push('', `subtypes: ${result.totalSubs}`);
		for (const s of result.subs) lines.push(`  ${s.kind} ${s.id}  ${s.path}:${s.line}  via ${s.via} (${s.confidence})`);
	} else {
		lines.push('', 'subtypes: none declared in this workspace');
	}
	if (result.overrides.length > 0) lines.push('', `overrides: ${result.overrides.join(', ')}`);
	if (result.inheritedNames.length > 0) lines.push(`inherited: ${result.inheritedNames.join(', ')}`);
	const own = result.members.filter((m) => !m.inherited).length;
	lines.push('', `members: ${own} own, ${result.members.length - own} inherited`);
	for (const m of result.members.slice(0, 40)) {
		lines.push(`  ${m.inherited ? '↑' : ' '} ${m.kind} ${m.name}${m.overrides ? ' (override)' : ''}${m.inherited ? `  from ${m.owner}` : ''}`);
	}
	return lines.join('\n');
}

function fmtSearch(result) {
	if (result.total === 0) return `search "${result.query}" — no match`;
	const lines = [`search "${result.query}" — ${result.total} match${result.total === 1 ? '' : 'es'}`];
	for (const m of result.matches) {
		lines.push(`${m.score.toString().padStart(4)} ${m.kind} ${m.id}`);
		lines.push(`     ${m.path}:${m.line}  refs:${m.refs}  ${clip(m.sig, 120)}`);
	}
	if (result.truncated) lines.push(`…${result.total - result.matches.length} more`);
	return lines.join('\n');
}

function fmtStatus(result) {
	return [
		`index ${result.ready ? 'ready' : 'not ready'} — ${result.files} files, ${result.symbols} symbols, generation ${result.generation}`,
		`  root ${result.root}`,
		`  cache ${result.cacheDir}`,
		`  engine ${result.modes.engine} (${result.modes.languages.join(', ')})`,
		`  tsconfig baseUrl "${result.baseUrl}" paths ${result.tsconfigPaths} · go.module "${result.goModule}"`,
		result.build ? `  last build ${result.build.indexed}/${result.build.files} files in ${result.build.ms}ms` : '',
		result.skipped > 0
			? `  warning: ${result.skipped} file(s) could not be parsed and are NOT indexed (${result.skippedSample.join(', ')})`
			: '',
	].filter(Boolean).join('\n');
}

function fmtVerify(result) {
	const s = result.summary;
	const lines = [
		`verify — verdict: ${result.verdict}`,
		`  ${s.files} file${s.files === 1 ? '' : 's'} changed (${s.removedFiles} deleted${s.newFiles ? `, ${s.newFiles} new` : ''}) · +${s.added} -${s.removed} symbols · ${s.contractChanges} contract · ${s.bodyOnlyChanges} body-only`,
	];
	if (result.contract.length > 0) {
		lines.push('', 'contract changes (callers may need editing):');
		for (const c of result.contract) lines.push(`  ${c.kind} ${c.id}  refs:${c.refs}  ${clip(c.sig, 140)}`);
	}
	if (result.bodyOnly.length > 0) {
		lines.push('', 'body-only (signature unchanged, callers unaffected):');
		for (const c of result.bodyOnly) lines.push(`  ${c.id}  refs:${c.refs}`);
	}
	if (result.removedSymbols?.length > 0) {
		lines.push('', 'symbols that no longer exist:');
		for (const id of result.removedSymbols) lines.push(`  ${id}`);
	}
	if (result.dangling.length > 0) {
		lines.push('', 'references that no longer resolve:');
		for (const d of result.dangling) lines.push(`  ${d.severity} ${d.path}:${d.line}  ${d.name}  ${clip(d.text, 120)}`);
	}
	if (result.hardHits.length > 0) {
		lines.push('', 'sites that call a changed signature:');
		for (const h of result.hardHits) lines.push(`  ${h.path}:${h.line}  ${h.role}  ${h.owner ? `in ${h.owner}` : ''}  ${clip(h.text, 120)}`);
	}
	if (result.unverified.length > 0) lines.push('', `unverified: ${result.unverified.join('; ')}`);
	if (s.files === 0) lines.push('nothing changed since the index caught up — nothing to re-check');
	return lines.join('\n');
}

function renderResult(toolName, value) {
	if (toolName === 'code_verify') return fmtVerify(value);
	if (value.error) return `error: ${value.error}`;
	switch (value.op) {
		case 'find': return fmtFind(value);
		case 'outline': return fmtOutline(value);
		case 'refs': return fmtRefs(value);
		case 'hierarchy': return fmtHierarchy(value);
		case 'search': return fmtSearch(value);
		case 'status': return fmtStatus(value);
		default: return JSON.stringify(value).slice(0, 2000);
	}
}

/**
 * @param {{ query: import('./query.js').CodeQuery, index: import('./store.js').CodeIndex, ensureReady: () => Promise<void> }} service
 */
export function createTools(service) {
	const codeQuery = {
		name: 'code_query',
		description:
			'Look up declarations, references, and inheritance in the workspace index instead of grepping and reading files. Answers are line-addressable; confidence marks guesses.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			required: ['op'],
			properties: {
				op: {
					type: 'string',
					enum: ['find', 'outline', 'refs', 'hierarchy', 'search', 'status'],
					description: 'find: locate a symbol by name. outline: declarations in one file. refs: who mentions a symbol. hierarchy: extends/implements and members. search: substring over names and signatures. status: is the index built.',
				},
				name: { type: 'string', description: 'For find/refs/hierarchy: a bare name (`addNode`), a qualified name (`Graph.addNode`), or a full id (`ts:src/x.ts#Graph.addNode`).' },
				path: { type: 'string', description: 'For outline: a workspace-relative path; a unique suffix is accepted.' },
				text: { type: 'string', description: 'For search: space-separated substrings; all must match.' },
				kind: { type: 'string', description: 'For find: restrict to one kind (class, interface, function, method, type, variable, struct, field).' },
				limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum items returned. Defaults: 10 for find/search, 40 for refs, 200 for outline.' },
			},
		},
		output: {
			schema: { type: 'object' },
			render: (_args, value) => text(renderResult('code_query', value)),
			presentationMeta: (args, value) => {
				const files = new Map();
				const push = (p, lineNumber, line) => {
					if (!files.has(p)) files.set(p, []);
					files.get(p).push({ lineNumber, line });
				};
				if (value.op === 'find') for (const m of value.matches ?? []) push(m.path, m.line, `${m.kind} ${m.qual}`);
				if (value.op === 'refs') for (const s of value.sites ?? []) push(s.path, s.line, s.text);
				if (value.op === 'search') for (const m of value.matches ?? []) push(m.path, m.line, `${m.kind} ${m.qual}`);
				if (value.op === 'outline') for (const item of value.items ?? []) push(value.path, item.line, `${item.kind} ${item.qual}`);
				return {
					title: `code_query ${args.op}${args.name ? ` ${args.name}` : ''}${args.path ? ` ${args.path}` : ''}`,
					kind: 'search',
					shape: 'matches',
					files: [...files].map(([p, matches]) => ({ path: p, matches })),
					total: value.total ?? 0,
					truncated: Boolean(value.truncated),
				};
			},
		},
		async execute(args, exec) {
			await service.ensureReady(exec);
			const q = service.query;
			switch (args.op) {
				case 'find': return q.find({ name: args.name ?? '', kind: args.kind, limit: args.limit ?? 10 });
				case 'outline': return q.outline({ pathFilter: args.path ?? '', limit: args.limit ?? 200 });
				case 'refs': return q.refs(args.name ?? '', { limit: args.limit ?? 40 });
				case 'hierarchy': return q.hierarchy(args.name ?? '');
				case 'search': return q.search({ text: args.text ?? args.name ?? '', limit: args.limit ?? 10 });
				case 'status': return q.status();
				default: return { error: `unknown op: ${args.op}` };
			}
		},
		presentCall(args) {
			return { title: `code_query ${args.op}${args.name ? ` ${args.name}` : ''}`, kind: 'search' };
		},
		presentResult(_args, result) {
			if (!result.meta) return undefined;
			return {
				card: 'search',
				shape: result.meta.shape,
				title: result.meta.title,
				files: result.meta.files,
				total: result.meta.total,
				truncated: result.meta.truncated,
			};
		},
	};

	const codeVerify = {
		name: 'code_verify',
		description:
			'After editing, re-extract changed files and report what the change broke: contract vs body-only, references that no longer resolve, and the call sites that still need attention. Call this instead of a full re-scan.',
		parameters: {
			type: 'object',
			additionalProperties: false,
			properties: {
				paths: {
					type: 'array',
					items: { type: 'string' },
					description: 'Workspace-relative files to re-check. Omit to check every indexed file that changed on disk.',
				},
			},
		},
		output: {
			schema: { type: 'object' },
			render: (_args, value) => text(renderResult('code_verify', value)),
		},
		isConcurrencySafe: () => false,
		async execute(args, exec) {
			await service.ensureReady(exec);
			const result = await service.query.verify({ paths: args.paths ?? [] });
			service.journal?.clearVerified(result.summary.files > 0 ? args.paths ?? [] : []);
			return result;
		},
		presentCall() {
			return { title: 'code_verify', kind: 'search' };
		},
	};

	return [codeQuery, codeVerify];
}
