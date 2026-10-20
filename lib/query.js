/**
 * Query operations. Every operation is bounded: it returns what it can prove,
 * says how much it saw, and never turns a partial answer into a confident one.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { toPosix } from './files.js';
import { Resolver } from './resolve.js';

const CALL_ROLES = new Set(['call', 'new']);

export class CodeQuery {
	/**
	 * @param {import('./store.js').CodeIndex} index
	 */
	constructor(index) {
		this.index = index;
		this.resolver = new Resolver(index);
		this._refCounts = null;
		this._refCountsGeneration = -1;
	}

	async ensure() {
		await this.index.ensure();
		await this.resolver.loadConfigs();
	}

	// ---- helpers ------------------------------------------------------------

	/** name -> number of mention sites. Built once per index generation. */
	refCounts() {
		if (this._refCountsGeneration === this.index.generation && this._refCounts) return this._refCounts;
		const counts = new Map();
		for (const fact of this.index.facts.values()) {
			for (const ref of fact.refs ?? []) counts.set(ref.n, (counts.get(ref.n) ?? 0) + 1);
		}
		this._refCounts = counts;
		this._refCountsGeneration = this.index.generation;
		return counts;
	}

	async lineText(relPath, line) {
		if (!this._lineCache) this._lineCache = new Map();
		let lines = this._lineCache.get(relPath);
		if (!lines) {
			try {
				const text = await fs.readFile(path.join(this.index.root, relPath), 'utf8');
				lines = text.split('\n');
				this._lineCache.set(relPath, lines);
				if (this._lineCache.size > 64) this._lineCache.delete(this._lineCache.keys().next().value);
			} catch {
				lines = [];
				this._lineCache.set(relPath, lines);
			}
		}
		return (lines[line - 1] ?? '').trim().slice(0, 200);
	}

	describe(node) {
		return {
			id: node.id,
			name: node.name,
			kind: node.kind,
			qual: node.qual,
			path: node.path,
			line: node.line,
			endLine: node.endLine,
			sig: node.sig,
			exported: node.exported,
			parent: node.parent,
			refs: this.refCounts().get(node.name) ?? 0,
		};
	}

	// ---- find ---------------------------------------------------------------

	async find({ name, kind, pathFilter, limit = 10, fuzzy = true }) {
		const hits = [];
		const seen = new Set();
		const push = (node) => {
			if (!node || seen.has(node.id)) return;
			if (kind && node.kind !== kind) return;
			if (pathFilter && !node.path.includes(pathFilter)) return;
			seen.add(node.id);
			hits.push(node);
		};

		for (const node of this.index.byNameAll(name)) push(node);
		// qualified form: `Graph.addNode`, `pkg.Func`, `path/to/file#Name`
		if (hits.length === 0 && (name.includes('.') || name.includes('#'))) {
			const qual = name.replace(/^[a-z]+:/, '').replace('#', '');
			for (const node of this.index.symbols.values()) if (node.qual === qual || node.id.endsWith(`#${qual}`)) push(node);
		}
		let mode = 'exact';
		if (hits.length === 0 && fuzzy) {
			mode = 'fuzzy';
			const needle = name.toLowerCase();
			for (const node of this.index.symbols.values()) {
				if (node.name.toLowerCase().includes(needle) || node.qual.toLowerCase().includes(needle)) push(node);
				if (hits.length >= limit * 4) break;
			}
		}

		const sorted = hits
			.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
			.slice(0, limit)
			.map((node) => this.describe(node));

		return {
			op: 'find',
			query: name,
			mode,
			total: hits.length,
			truncated: hits.length > sorted.length,
			matches: sorted,
		};
	}

	// ---- outline ------------------------------------------------------------

	async outline({ pathFilter, limit = 200 }) {
		const relPath = this.normalizePath(pathFilter);
		const fact = this.index.facts.get(relPath);
		if (!fact) {
			const candidates = [...this.index.facts.keys()]
				.filter((p) => p.endsWith(relPath) || p.includes(relPath))
				.slice(0, 8);
			if (candidates.length === 1) return this.outline({ pathFilter: candidates[0], limit });
			return { op: 'outline', path: relPath, total: 0, truncated: false, items: [], candidates };
		}
		const order = (d) => [d.l, (d.q || d.n).split('.').length];
		const decls = [...(fact.decls ?? [])].sort((a, b) => {
			const [la, da] = order(a);
			const [lb, db] = order(b);
			return la - lb || da - db;
		});
		const items = decls.slice(0, limit).map((d) => ({
			id: `${fact.lang}:${relPath}#${d.q || d.n}`,
			name: d.n,
			kind: d.k,
			qual: d.q || d.n,
			depth: d.q ? d.q.split('.').length - 1 : 0,
			line: d.l,
			endLine: d.el,
			sig: d.sig,
			exported: Boolean(d.x),
			heritage: (d.h ?? []).map(([k, n]) => `${k} ${n}`).join(' '),
		}));
		return {
			op: 'outline',
			path: relPath,
			lang: fact.lang,
			imports: (fact.imports ?? []).length,
			total: decls.length,
			truncated: decls.length > items.length,
			items,
		};
	}

	normalizePath(input) {
		if (!input) return '';
		const trimmed = toPosix(input).replace(/^\.\//, '');
		if (trimmed.startsWith('/')) {
			const rootPosix = toPosix(this.index.root);
			return trimmed.slice(rootPosix.length).replace(/^\//, '');
		}
		return trimmed;
	}

	// ---- refs ---------------------------------------------------------------

	/**
	 * Sites that mention `target`. Each candidate mention is resolved, so a
	 * same-named local variable elsewhere does not become a false caller.
	 */
	async refs(targetId, { limit = 40, includeTests = true, roles } = {}) {
		const node = this.index.symbol(targetId) ?? (await this.findOne(targetId));
		if (!node) return { op: 'refs', error: `unknown symbol: ${targetId}`, sites: [], total: 0, truncated: false };
		const name = node.name;
		const sites = [];
		let scanned = 0;
		let candidates = 0;
		let ambiguous = 0;
		let unresolved = 0;
		const seen = new Set();

		for (const fact of this.index.facts.values()) {
			const refs = fact.refs;
			if (!refs) continue;
			for (let i = 0; i < refs.length; i += 1) {
				const ref = refs[i];
				if (ref.n !== name) continue;
				if (ref.path === undefined && fact.path === node.path && ref.l === node.line) continue;
				candidates += 1;
				if (scanned >= 6000) break;
				scanned += 1;
				if (roles && !roles.has(ref.r)) continue;
				if (!includeTests && /\.(test|spec)\./.test(fact.path)) continue;
				if (!includeTests && /(^|\/)(__tests__|test|tests)\//.test(fact.path)) continue;

				const ownerDecl = ref.o >= 0 ? fact.decls?.[ref.o] : undefined;
				const ownerId = ownerDecl ? `${fact.lang}:${fact.path}#${ownerDecl.q || ownerDecl.n}` : undefined;
				const resolved = this.resolver.resolveName(fact.path, name, { via: ref.v, owner: ownerId });
				const key = `${fact.path}:${ref.l}:${ref.c}`;
				if (seen.has(key)) continue;
				seen.add(key);
				const exact = resolved.targets.find((t) => t.node.id === node.id);
				if (exact) {
					sites.push({
						path: fact.path,
						line: ref.l,
						col: ref.c,
						role: ref.r,
						confidence: exact.confidence,
						owner: ownerDecl?.q ?? ownerDecl?.n ?? '',
						text: await this.lineText(fact.path, ref.l),
					});
				} else if (resolved.reason === 'ambiguous') {
					ambiguous += 1;
				} else if (resolved.targets.length === 0) {
					unresolved += 1;
				}
				if (sites.length >= limit) break;
			}
			if (sites.length >= limit || scanned >= 6000) break;
		}

		sites.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
		return {
			op: 'refs',
			target: this.describe(node),
			sites,
			total: sites.length,
			truncated: sites.length >= limit || scanned >= 6000,
			scanned,
			candidates,
			ambiguous,
			unresolved,
		};
	}

	async findOne(idOrName) {
		const direct = this.index.symbol(idOrName);
		if (direct) return direct;
		const byName = this.index.byNameAll(idOrName);
		if (byName.length === 1) return byName[0];
		return null;
	}

	// ---- hierarchy ----------------------------------------------------------

	async hierarchy(targetId) {
		const node = await this.findOne(targetId);
		if (!node) return { op: 'hierarchy', error: `unknown symbol: ${targetId}`, supers: [], subs: [], members: [], overrides: [] };

		const supers = node.heritage.map((h) => {
			const candidates = this.index.byNameAll(h.name).filter((n) => ['class', 'interface', 'struct', 'type'].includes(n.kind));
			return {
				kind: h.kind,
				name: h.name,
				line: h.line,
				resolved: candidates.length === 1 ? candidates[0] : null,
				candidates: candidates.slice(0, 4),
				confidence: candidates.length === 1 ? (h.kind === 'implements' ? 'heuristic' : 'resolved') : 'ambiguous',
			};
		});

		const subs = this.index.subtypesOf(node.name).map((sub) => ({
			id: sub.id,
			qual: sub.qual,
			kind: sub.kind,
			path: sub.path,
			line: sub.line,
			via: sub.heritage.find((h) => h.name === node.name)?.kind ?? 'extends',
			confidence: node.kind === 'interface' || node.kind === 'struct' ? 'heuristic' : 'resolved',
		}));

		const members = (this.index.byPath(node.path) ?? []).filter((m) => m.parent === node.id);
		const ancestors = this.index.ancestorsOf(node.id);
		const ancestorMembers = [];
		const ownNames = new Set(members.map((m) => m.name));
		for (const ancestor of ancestors) {
			const inherited = (this.index.byPath(ancestor.path) ?? []).filter((m) => m.parent === ancestor.id);
			for (const m of inherited) {
				ancestorMembers.push({ ...m, owner: ancestor.qual });
			}
		}
		return {
			op: 'hierarchy',
			target: this.describe(node),
			supers,
			subs: subs.slice(0, 50),
			totalSubs: subs.length,
			members: [
				...members.map((m) => ({ name: m.name, kind: m.kind, line: m.line, sig: m.sig, owner: node.qual, overrides: ancestorMembers.some((a) => a.name === m.name) })),
				...ancestorMembers.filter((m) => !ownNames.has(m.name)).map((m) => ({ name: m.name, kind: m.kind, line: m.line, sig: m.sig, owner: m.owner, inherited: true })),
			].slice(0, 120),
			overrides: members.filter((m) => ancestorMembers.some((a) => a.name === m.name)).map((m) => m.name),
			inheritedNames: ancestorMembers.filter((a) => !ownNames.has(a.name)).map((a) => a.name),
		};
	}

	// ---- search -------------------------------------------------------------

	async search({ text, limit = 20 }) {
		const terms = text.toLowerCase().split(/\s+/).filter(Boolean);
		if (terms.length === 0) return { op: 'search', query: text, total: 0, truncated: false, matches: [] };
		const scored = [];
		for (const node of this.index.symbols.values()) {
			const haystackName = node.name.toLowerCase();
			const haystackQual = node.qual.toLowerCase();
			const haystackSig = (node.sig ?? '').toLowerCase();
			let score = 0;
			let matchedAll = true;
			for (const term of terms) {
				let termScore = 0;
				if (haystackName === term) termScore += 100;
				else if (haystackName.startsWith(term)) termScore += 60;
				else if (haystackName.includes(term)) termScore += 40;
				else if (haystackQual.includes(term)) termScore += 25;
				else if (haystackSig.includes(term)) termScore += 15;
				else if (node.path.toLowerCase().includes(term)) termScore += 8;
				if (termScore === 0) {
					matchedAll = false;
					break;
				}
				score += termScore;
			}
			if (!matchedAll) continue;
			score += Math.min(10, this.refCounts().get(node.name) ?? 0);
			scored.push({ node, score });
		}
		scored.sort((a, b) => b.score - a.score || a.node.path.localeCompare(b.node.path));
		const matches = scored.slice(0, limit).map(({ node, score }) => ({ ...this.describe(node), score }));
		return { op: 'search', query: text, total: scored.length, truncated: scored.length > matches.length, matches };
	}

	// ---- status -------------------------------------------------------------

	async status() {
		const base = this.index.status();
		return {
			op: 'status',
			...base,
			root: toPosix(base.root),
			tsconfigPaths: this.resolver.tsconfig.paths.length,
			baseUrl: this.resolver.tsconfig.baseUrl || '.',
			goModule: this.resolver.goModule,
			modes: { engine: 'heuristic', languages: ['ts', 'js', 'go'] },
			commits: 'freshness is checked per answer; call verify for a full check',
		};
	}

	// ---- verify -------------------------------------------------------------

	/**
	 * The post-edit check: what did the change do to the contract, and which
	 * sites now need a human look?
	 */
	async verify({ paths = [], full = false } = {}) {
		const targets = paths.length > 0 ? paths.map((p) => this.normalizePath(p)) : [...this.index.facts.keys()];
		const stale = full ? targets : await this.index.stalePaths(targets);
		// A file created since the last build is in no manifest entry, so walking
		// the tree is the only way to see it. Only when the caller did not say
		// which files to check - an explicit path list is a promise we keep.
		let created = [];
		let scanError;
		if (paths.length === 0) {
			try {
				created = (await this.index.scanPaths()).filter((p) => !this.index.facts.has(p));
			} catch (error) {
				scanError = error.message;
			}
		}
		const reindexed = [...new Set([...stale, ...created])];
		// Snapshot what every mention pointed at *before* the change. A symbol
		// that disappears is only "dangling" when it used to be the target:
		// without this, renaming a directory reports every `filepath.Base` in
		// the repo as a broken reference, and a false positive is worse than a
		// missing one because it burns the reader's trust.
		const preTargets = new Map();
		const preNames = new Set();
		let scannedPre = 0;
		for (const path of reindexed) {
			for (const decl of this.index.facts.get(path)?.decls ?? []) {
				if (decl.n) preNames.add(decl.n);
			}
		}
		for (const name of preNames) {
			const check = await this.sitesForName(name, { limit: 400 });
			scannedPre += check.scanned;
			for (const site of check.sites) {
				preTargets.set(`${site.path}:${site.line}:${site.col}:${name}`, {
					id: site.targetId,
					confidence: site.confidence,
				});
			}
		}

		const delta = await this.index.reindex(reindexed);
		this._lineCache = null;

		const removedIds = new Set(delta.removed);
		const changedIds = new Map(delta.changed.map((c) => [c.id, c.reason]));
		const contract = [];
		const bodyOnly = [];
		for (const id of changedIds.keys()) {
			const node = this.index.symbol(id);
			if (!node) {
				removedIds.add(id);
				continue;
			}
			// A container's body hash covers every member, so it always "changes"
			// when any member does. Reporting it would double every edit; the
			// members themselves carry the real signal.
			if (CONTAINER_KINDS.has(node.kind)) continue;
			(contractOrBody(node, changedIds.get(id)) ? contract : bodyOnly).push(node);
		}

		const dangling = [];
		const hardHits = [];
		let scannedRemoved = 0;
		let retargeted = 0;
		const seenNames = new Set();
		for (const id of removedIds) {
			const name = id.includes('#') ? id.slice(id.indexOf('#') + 1).split('.').pop() : id;
			if (seenNames.has(name)) continue;
			seenNames.add(name);
			const check = await this.sitesForName(name, { limit: 400 });
			scannedRemoved += check.scanned;
			for (const site of check.sites) {
				const key = `${site.path}:${site.line}:${site.col}:${name}`;
				// Only a site that used to resolve to this very symbol can be
				// broken by its removal. Everything else (a mention that never
				// resolved, or one that points somewhere valid) is noise.
				const pre = preTargets.get(key);
				if (!pre || pre.id !== id) continue;
				// A heuristic match was a guess; when the guess stops landing
				// that is not evidence of a broken reference.
				if (pre.confidence === 'heuristic') continue;
				if (site.targetId === null) dangling.push({ ...site, name, severity: 'dangling' });
				else if (site.targetId !== id) retargeted += 1;
			}
		}
		scannedRemoved += scannedPre;
		for (const node of contract.slice(0, 20)) {
			const check = await this.sitesForName(node.name, { limit: 200 });
			for (const site of check.sites) {
				if (site.targetId === node.id) hardHits.push({ ...site, name: node.name, signature: node.sig });
			}
		}

		const summary = {
			files: delta.files.length,
			removedFiles: delta.removedFiles.length,
			newFiles: created.length,
			unchanged: delta.unchanged.length,
			added: delta.added.length,
			removed: removedIds.size,
			contractChanges: contract.length,
			bodyOnlyChanges: bodyOnly.length,
			dangling: dangling.filter((d) => d.severity === 'dangling').length,
			retargeted,
			hardHits: hardHits.length,
			scannedRemoved,
			failed: delta.failed?.length ?? 0,
		};

		return {
			op: 'verify',
			summary,
			verdict: verdictOf(summary),
			contract: contract.map((n) => this.describe(n)),
			bodyOnly: bodyOnly.map((n) => this.describe(n)),
			removedSymbols: [...removedIds].slice(0, 60),
			dangling: dangling.slice(0, 60),
			hardHits: hardHits.slice(0, 60),
			unverified: unverifiedOf(summary, scanError),
		};
	}

	/** Sites mentioning `name`, with the target each resolves to. */
	async sitesForName(name, { limit = 200 } = {}) {
		const sites = [];
		let scanned = 0;
		for (const fact of this.index.facts.values()) {
			for (const ref of fact.refs ?? []) {
				if (ref.n !== name) continue;
				if (scanned >= 6000) break;
				scanned += 1;
				const ownerDecl = ref.o >= 0 ? fact.decls?.[ref.o] : undefined;
				const ownerId = ownerDecl ? `${fact.lang}:${fact.path}#${ownerDecl.q || ownerDecl.n}` : undefined;
				const resolved = this.resolver.resolveName(fact.path, name, { via: ref.v, owner: ownerId });
				const best = resolved.targets[0];
				sites.push({
					path: fact.path,
					line: ref.l,
					col: ref.c,
					role: ref.r,
					owner: ownerDecl?.q ?? '',
					targetId: best?.node.id ?? null,
					confidence: best?.confidence ?? 'unresolved',
					text: await this.lineText(fact.path, ref.l),
				});
				if (sites.length >= limit) break;
			}
			if (sites.length >= limit) break;
		}
		return { sites, scanned };
	}
}

const VALUE_KINDS = new Set(['variable', 'field']);
const CONTAINER_KINDS = new Set(['class', 'interface', 'namespace', 'module', 'enum', 'struct', 'trait', 'impl']);

function contractOrBody(node, reason) {
	if (reason !== 'signature') return false;
	// For a value binding the "signature" hash covers the initializer, so editing
	// `const timeout = 30` to `= 60` changes it. That is a value change, not a
	// contract change, and treating it as breaking is exactly the false alarm the
	// scoped-verification workflow is supposed to remove.
	if (node !== undefined && VALUE_KINDS.has(node.kind)) return false;
	return true;
}

function verdictOf(summary) {
	if (summary.dangling > 0) return 'breaking';
	if (summary.contractChanges > 0 || summary.removed > 0) return 'contract';
	if (summary.files > 0) return 'internal';
	return 'clean';
}

function unverifiedOf(summary, scanError) {
	const notes = [];
	if (scanError) notes.push(`could not scan for new files (${scanError}); only known paths were checked`);
	if (summary.failed > 0) notes.push(`${summary.failed} changed file(s) could not be parsed and were not analysed`);
	if (summary.scannedRemoved >= 6000) notes.push('reference scan hit its cap; some sites were not resolved');
	notes.push('cross-language and dynamic references are not modelled');
	notes.push('type-level compatibility of changed signatures is not checked here');
	return notes;
}

export { CALL_ROLES };
