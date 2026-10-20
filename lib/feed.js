/**
 * The read-only feed behind the Web UI page.
 *
 * The tools answer one question at a time; a picture needs the whole shape at
 * once. This module turns an index into one compact JSON document: files,
 * their resolved import edges, and the inheritance declarations. It is derived
 * data only — nothing here is a second source of truth, and every call to
 * `overview()` is keyed by the index generation so an edit invalidates it for
 * free.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { hashShort, toPosix } from './files.js';
import { Resolver } from './resolve.js';
import { CodeIndex, INDEX_VERSION } from './store.js';

/** Declarations that can carry `extends` / `implements` / `embeds`. */
const HERITAGE_KINDS = new Set(['class', 'interface', 'struct', 'trait', 'impl', 'enum']);

const MAX_GRAPH_FILES = 1500;
const MAX_TYPES = 800;
const OVERVIEW_CACHE_ENTRIES = 8;

/** The cache directory for one workspace root. Single definition: the tools and the page must agree. */
export function cacheDirFor(cacheRoot, root) {
	return path.join(cacheRoot, hashShort(`v1|${toPosix(root)}`));
}

function ageOf(timestamp) {
	return timestamp ? Math.max(0, Date.now() - timestamp) : null;
}

/** A rejected request, not a broken host: the page shows the message verbatim. */
function badRequest(message) {
	return Object.assign(new Error(message), { status: 400 });
}

export class FeedService {
	/**
	 * @param {{ cacheRoot: string, log?: (message: string) => void }} options
	 */
	constructor(options) {
		this.cacheRoot = options.cacheRoot;
		this.log = options.log ?? (() => {});
		/** @type {Map<string, CodeIndex>} */
		this.indexes = new Map();
		/** @type {Map<string, { generation: number, value: any }>} */
		this.overviews = new Map();
	}

	/** Every workspace that has an index on disk, newest first. */
	async roots() {
		let entries;
		try {
			entries = await fs.readdir(this.cacheRoot, { withFileTypes: true });
		} catch {
			return [];
		}
		const out = [];
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dir = path.join(this.cacheRoot, entry.name);
			try {
				const raw = await fs.readFile(path.join(dir, 'manifest.json'), 'utf8');
				const manifest = JSON.parse(raw);
				if (manifest.version !== INDEX_VERSION || typeof manifest.root !== 'string') continue;
				out.push({
					root: manifest.root,
					files: Object.keys(manifest.files ?? {}).length,
					updatedAt: manifest.updatedAt ?? 0,
					ageMs: ageOf(manifest.updatedAt),
				});
			} catch {
				/* a half-written cache is not an error worth surfacing here */
			}
		}
		out.sort((a, b) => b.updatedAt - a.updatedAt);
		return out;
	}

	/** Reuse a live index when the caller already has one (the tools do), else load from disk. */
	async indexFor(root, { signal } = {}) {
		const resolved = path.resolve(root);
		const existing = this.indexes.get(resolved);
		if (existing?.ready) return existing;
		const index = existing ?? new CodeIndex({ root: resolved, cacheDir: cacheDirFor(this.cacheRoot, resolved), log: this.log });
		this.indexes.set(resolved, index);
		await index.ensure({ signal });
		return index;
	}

	/**
	 * Index a directory the page asked for, then keep it. The page may suggest a
	 * path, but only the filesystem decides whether it exists — and a build
	 * failure leaves the workspace list untouched.
	 * @param {string} input absolute path as typed by the user
	 */
	async addRoot(input, { signal } = {}) {
		const raw = String(input ?? '').trim().replace(/^"(.*)"$/, '$1');
		if (!raw) throw badRequest('a directory path is required');
		const root = path.resolve(raw);
		if (!path.isAbsolute(raw)) throw badRequest(`an absolute path is required: ${raw}`);
		let stat;
		try {
			stat = await fs.stat(root);
		} catch {
			throw badRequest(`no such directory: ${root}`);
		}
		if (!stat.isDirectory()) throw badRequest(`not a directory: ${root}`);
		const index = await this.indexFor(root, { signal });
		this.overviews.delete(index.root);
		return {
			root: index.root,
			files: Object.keys(index.manifest.files).length,
			symbols: index.status().symbols,
			skipped: index.status().skipped,
		};
	}

	async resolverFor(index) {
		if (index._resolver) return index._resolver;
		const resolver = new Resolver(index);
		await resolver.loadConfigs();
		index._resolver = resolver;
		return resolver;
	}

	/** Compare every indexed file against the disk and pull in files that appeared. */
	async refresh(index, { signal } = {}) {
		const known = Object.keys(index.manifest.files);
		const stale = await index.stalePaths(known);
		let created = [];
		try {
			const onDisk = await index.scanPaths({ signal });
			created = onDisk.filter((relPath) => !index.facts.has(relPath));
		} catch (error) {
			this.log(`scan for new files failed: ${error?.message ?? error}`);
		}
		const dirty = [...new Set([...stale, ...created])];
		if (dirty.length > 0) await index.reindex(dirty, { signal });
		return { checked: known.length + created.length, changed: dirty.length };
	}

	/**
	 * The whole picture as one document.
	 * @param {string} root
	 * @param {{ refresh?: boolean, signal?: AbortSignal }} options
	 */
	async overview(root, { refresh: force = false, signal } = {}) {
		const index = await this.indexFor(root, { signal });
		if (force) await this.refresh(index, { signal });
		const cached = this.overviews.get(index.root);
		if (!force && cached && cached.generation === index.generation) return cached.value;
		const resolver = await this.resolverFor(index);
		const value = buildOverview(index, resolver);
		this.overviews.set(index.root, { generation: index.generation, value });
		if (this.overviews.size > OVERVIEW_CACHE_ENTRIES) {
			const oldest = this.overviews.keys().next().value;
			if (oldest !== undefined && oldest !== index.root) this.overviews.delete(oldest);
		}
		return value;
	}

	/** One file's symbols, for the detail panel. Small on purpose: no whole-index payloads. */
	async fileDetail(root, relPath) {
		const index = await this.indexFor(root);
		const fact = index.facts.get(relPath);
		if (!fact) return null;
		const symbols = (index.byFile.get(relPath) ?? new Set()).size
			? [...index.byFile.get(relPath)].map((id) => index.symbols.get(id)).filter(Boolean)
			: [];
		return {
			path: relPath,
			lang: fact.lang,
			symbols: symbols
				.sort((a, b) => a.line - b.line)
				.map((node) => ({
					n: node.name,
					q: node.qual,
					k: node.kind,
					l: node.line,
					el: node.endLine,
					x: node.exported ? 1 : 0,
					s: node.sig,
					h: node.heritage.map((h) => [h.kind, h.name]),
				})),
			imports: (fact.imports ?? []).map((imp) => ({ spec: imp.from, names: imp.imported ?? imp.local, line: imp.line })),
			exports: (fact.exports ?? []).filter((item) => !item.from && !item.star).map((item) => item.exported),
		};
	}
}

/**
 * Pure transform. Kept exported and free of I/O so a test can build a payload
 * from a fixture without starting the web server.
 */
export function buildOverview(index, resolver) {
	const paths = Object.keys(index.manifest.files).sort();
	const truncated = paths.length > MAX_GRAPH_FILES;
	const kept = truncated ? paths.slice(0, MAX_GRAPH_FILES) : paths;
	const keptSet = new Set(kept);
	const langs = {};
	const files = [];
	/** @type {[string, string, string][]} */
	const edges = [];
	const edgeKeys = new Set();

	for (const relPath of kept) {
		const fact = index.facts.get(relPath);
		if (!fact) continue;
		const lang = fact.lang ?? index.manifest.files[relPath]?.l ?? 'ts';
		langs[lang] = (langs[lang] ?? 0) + 1;
		const symbols = index.byFile.get(relPath)?.size ?? 0;
		const exported = (fact.exports ?? []).filter((item) => !item.from && !item.star).length;
		const deps = [];
		for (const imp of fact.imports ?? []) {
			const resolved = resolver?.resolveModule?.(relPath, imp.from);
			const targets = resolved?.path ? [resolved.path] : resolved?.files ?? [];
			for (const target of targets) {
				if (!keptSet.has(target) || target === relPath) continue;
				const key = `${relPath}\u0000${target}`;
				if (edgeKeys.has(key)) continue;
				edgeKeys.add(key);
				deps.push(target);
				edges.push([relPath, target, 'import']);
			}
		}
		files.push({ p: relPath, l: lang, n: symbols, x: exported, i: deps });
	}

	/** @type {any[]} */
	const types = [];
	for (const node of index.symbols.values()) {
		if (!node.heritage?.length) continue;
		if (!HERITAGE_KINDS.has(node.kind)) continue;
		if (types.length >= MAX_TYPES) break;
		types.push({
			id: node.id,
			n: node.name,
			k: node.kind,
			p: node.path,
			l: node.line,
			sup: node.heritage.map((h) => h.name),
			hk: node.heritage.map((h) => h.kind),
		});
	}
	// Reverse edges stay inside the indexed names, so "who implements this" is
	// answered for code we can see and never invented for code we cannot.
	const byName = new Map();
	for (const type of types) {
		if (!byName.has(type.n)) byName.set(type.n, []);
		byName.get(type.n).push(type.id);
	}
	const subs = new Map();
	for (const type of types) {
		for (const name of type.sup) {
			for (const child of byName.get(name) ?? []) {
				if (!subs.has(type.id)) subs.set(type.id, []);
				subs.get(type.id).push(child);
			}
		}
	}
	for (const type of types) type.sub = subs.get(type.id) ?? [];

	const dirs = new Map();
	for (const file of files) {
		const dir = toPosix(path.posix.dirname(file.p));
		const bucket = dirs.get(dir) ?? { d: dir, files: 0, symbols: 0 };
		bucket.files += 1;
		bucket.symbols += file.n;
		dirs.set(dir, bucket);
	}

	const status = index.status();
	return {
		root: index.root,
		generatedAt: Date.now(),
		status: {
			files: status.files,
			symbols: status.symbols,
			names: status.names,
			generation: status.generation,
			skipped: status.skipped,
			skippedSample: status.skippedSample,
			indexedAt: status.indexedAt,
			ageMs: ageOf(status.indexedAt),
			build: status.build,
			langs,
		},
		dirs: [...dirs.values()].sort((a, b) => b.symbols - a.symbols),
		files,
		edges,
		types,
		truncated,
		totalFiles: paths.length,
	};
}
