/**
 * Fact storage and the in-memory symbol table.
 *
 * On disk: one JSON fact file per source file, keyed by path (not by content),
 * plus a manifest. A file that did not change is never rewritten, and an edit
 * only dirties the edited file's own facts.
 *
 * In memory: symbols, a name -> symbol inverted index, a file -> symbols index,
 * and a heritage (extends/implements) inverted index. Edges are not stored;
 * they are computed at query time from names plus imports.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { extractGo } from './lang-go.js';
import { extractJsTs } from './lang-js.js';
import { hashShort, langOf, mapLimit, readSource, toPosix, walkSourceFiles } from './files.js';

export const INDEX_VERSION = 2;

/** Extract facts for one file. Kept in one place so engines can be swapped later. */
export function extractFacts(relPath, lang, text) {
	if (lang === 'go') return extractGo(relPath, text);
	return extractJsTs(relPath, text);
}

function symbolId(lang, relPath, qual) {
	return `${lang}:${relPath}#${qual}`;
}

function emptyIndex() {
	return {
		facts: new Map(),
		symbols: new Map(),
		byName: new Map(),
		byFile: new Map(),
		heritage: new Map(),
	};
}

export class CodeIndex {
	/**
	 * @param {{ root: string, cacheDir: string, maxFiles?: number, log?: (msg: string) => void }} options
	 */
	constructor(options) {
		this.root = options.root;
		this.cacheDir = options.cacheDir;
		this.maxFiles = options.maxFiles ?? 20000;
		this.log = options.log ?? (() => {});
		this.manifest = { version: INDEX_VERSION, root: this.root, createdAt: 0, updatedAt: 0, files: {} };
		Object.assign(this, emptyIndex());
		this.generation = 0;
		this.ready = false;
		this.building = null;
		this._saveTimer = null;
		this.lastBuild = null;
		/** Files the engine could not read or parse. Never silent: surfaced by status(). */
		this.failures = [];
	}

	get manifestPath() {
		return path.join(this.cacheDir, 'manifest.json');
	}

	get fileCount() {
		return Object.keys(this.manifest.files).length;
	}

	get symbolCount() {
		return this.symbols.size;
	}

	// ---- disk ---------------------------------------------------------------

	factPath(key) {
		return path.join(this.cacheDir, 'facts', key.slice(0, 2), `${key}.json`);
	}

	async readFact(key) {
		try {
			const raw = await fs.readFile(this.factPath(key), 'utf8');
			return JSON.parse(raw);
		} catch {
			return null;
		}
	}

	async writeFact(key, fact) {
		const target = this.factPath(key);
		await fs.mkdir(path.dirname(target), { recursive: true });
		const tmp = `${target}.${process.pid}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(fact), 'utf8');
		await fs.rename(tmp, target);
	}

	async saveManifest() {
		await fs.mkdir(this.cacheDir, { recursive: true });
		this.manifest.updatedAt = Date.now();
		const target = this.manifestPath;
		const tmp = `${target}.${process.pid}.tmp`;
		await fs.writeFile(tmp, JSON.stringify(this.manifest), 'utf8');
		await fs.rename(tmp, target);
	}

	scheduleSave(delay = 800) {
		if (this._saveTimer) return;
		this._saveTimer = setTimeout(() => {
			this._saveTimer = null;
			this.saveManifest().catch((error) => this.log(`manifest save failed: ${error.message}`));
		}, delay);
		this._saveTimer.unref?.();
	}

	// ---- memory -------------------------------------------------------------

	pluckFile(relPath) {
		const ids = this.byFile.get(relPath);
		if (ids) {
			for (const id of ids) {
				const node = this.symbols.get(id);
				if (!node) continue;
				this.symbols.delete(id);
				const bucket = this.byName.get(node.name);
				if (bucket) {
					bucket.delete(id);
					if (bucket.size === 0) this.byName.delete(node.name);
				}
				for (const h of node.heritage) {
					const hb = this.heritage.get(h.name);
					if (hb) {
						hb.delete(id);
						if (hb.size === 0) this.heritage.delete(h.name);
					}
				}
			}
			this.byFile.delete(relPath);
		}
		this.facts.delete(relPath);
	}

	installFact(fact) {
		const { path: relPath, lang } = fact;
		this.pluckFile(relPath);
		this.facts.set(relPath, fact);
		const decls = fact.decls ?? [];
		const ids = decls.map((d) => symbolId(lang, relPath, d.q || d.n));
		const fileIds = new Set();
		for (let i = 0; i < decls.length; i += 1) {
			const d = decls[i];
			const id = ids[i];
			const parent = d.p >= 0 && d.p < ids.length ? ids[d.p] : null;
			const heritage = (d.h ?? []).map(([kind, name, line]) => ({ kind, name, line }));
			/** @type {any} */
			const node = {
				id,
				name: d.n,
				kind: d.k,
				qual: d.q || d.n,
				path: relPath,
				lang,
				line: d.l,
				endLine: d.el ?? d.l,
				sig: d.sig ?? '',
				sh: d.sh ?? '',
				bh: d.bh ?? '',
				exported: Boolean(d.x),
				parent,
				heritage,
			};
			if (d.params) node.params = d.params;
			this.symbols.set(id, node);
			fileIds.add(id);
			let bucket = this.byName.get(node.name);
			if (!bucket) {
				bucket = new Set();
				this.byName.set(node.name, bucket);
			}
			bucket.add(id);
			for (const h of heritage) {
				let hb = this.heritage.get(h.name);
				if (!hb) {
					hb = new Set();
					this.heritage.set(h.name, hb);
				}
				hb.add(id);
			}
		}
		this.byFile.set(relPath, fileIds);
		return ids;
	}

	// ---- build / load -------------------------------------------------------

	async build({ signal, onProgress } = {}) {
		if (this.building) return this.building;
		this.building = this._build({ signal, onProgress }).finally(() => {
			this.building = null;
		});
		return this.building;
	}

	async _build({ signal, onProgress } = {}) {
		const started = Date.now();
		this.failures = [];
		const entries = await walkSourceFiles(this.root, {
			maxFiles: this.maxFiles,
			signal,
			onSkip: (reason) => this.log(reason),
		});
		const total = entries.length;
		let done = 0;
		const files = {};
		await fs.mkdir(this.cacheDir, { recursive: true });

		await mapLimit(entries, 12, async (entry) => {
			if (signal?.aborted) return;
			const read = await readSource(entry);
			done += 1;
			if (done % 200 === 0 || done === total) onProgress?.({ done, total });
			if (!read) {
				this.failures.push({ path: entry.path, reason: 'unreadable' });
				return;
			}
			let fact;
			try {
				fact = extractFacts(entry.path, entry.lang, read.text);
			} catch (error) {
				this.log(`extract failed ${entry.path}: ${error.message}`);
				this.failures.push({ path: entry.path, reason: error.message });
				return;
			}
			const key = hashShort(entry.path);
			try {
				await this.writeFact(key, fact);
			} catch (error) {
				this.log(`fact write failed ${entry.path}: ${error.message}`);
				this.failures.push({ path: entry.path, reason: error.message });
				return;
			}
			files[entry.path] = { k: key, h: read.hash, m: Math.round(read.mtimeMs), s: read.size, l: entry.lang };
		});

		this.manifest = {
			version: INDEX_VERSION,
			root: this.root,
			createdAt: this.manifest.createdAt || Date.now(),
			updatedAt: Date.now(),
			files,
		};
		await this.saveManifest();

		Object.assign(this, emptyIndex());
		for (const [relPath, meta] of Object.entries(files)) {
			const fact = await this.readFact(meta.k);
			if (fact) this.installFact(fact);
		}
		this.generation += 1;
		this.ready = true;
		this.lastBuild = { files: total, indexed: Object.keys(files).length, skipped: this.failures.length, ms: Date.now() - started };
		return this.lastBuild;
	}

	async load() {
		this.failures = [];
		const raw = await fs.readFile(this.manifestPath, 'utf8');
		const manifest = JSON.parse(raw);
		if (manifest.version !== INDEX_VERSION) throw new Error('index version mismatch');
		const entries = Object.entries(manifest.files ?? {});
		if (entries.length === 0) throw new Error('empty index');
		const facts = await mapLimit(entries, 32, async ([, meta]) => this.readFact(meta.k));
		if (facts.some((f) => !f)) throw new Error('missing fact files');
		this.manifest = manifest;
		Object.assign(this, emptyIndex());
		for (const fact of facts) this.installFact(fact);
		this.generation += 1;
		this.ready = true;
		return { files: entries.length, symbols: this.symbols.size };
	}

	async ensure({ signal } = {}) {
		if (this.ready) return { loaded: true };
		try {
			await this.load();
			return { loaded: true };
		} catch (error) {
			this.log(`rebuilding index: ${error.message}`);
			await this.build({ signal });
			return { loaded: false, ...this.lastBuild };
		}
	}

	// ---- incremental --------------------------------------------------------

	/** Which of these paths changed on disk since we indexed them? */
	async stalePaths(relPaths) {
		const stale = [];
		for (const relPath of relPaths) {
			const meta = this.manifest.files[relPath];
			try {
				const stat = await fs.stat(path.join(this.root, relPath));
				if (!meta) {
					if (stat.isFile()) stale.push(relPath);
					continue;
				}
				if (Math.round(stat.mtimeMs) !== meta.m || stat.size !== meta.s) stale.push(relPath);
			} catch {
				if (meta) stale.push(relPath);
			}
		}
		return stale;
	}

	/** Every source file currently on disk. Lets a caller notice files the manifest never saw. */
	async scanPaths({ signal } = {}) {
		const entries = await walkSourceFiles(this.root, { maxFiles: this.maxFiles, signal });
		return entries.map((entry) => entry.path);
	}

	/**
	 * Re-extract the given files and report the symbol-level delta.
	 * @param {string[]} relPaths
	 */	async reindex(relPaths, { signal } = {}) {
		const delta = { added: [], removed: [], changed: [], files: [], removedFiles: [], unchanged: [], failed: [] };
		const seen = new Set();
		for (const raw of relPaths) {
			const relPath = toPosix(raw);
			if (seen.has(relPath)) continue;
			seen.add(relPath);
			if (signal?.aborted) break;
			const lang = langOf(relPath);
			const abs = path.join(this.root, relPath);
			const entry = { path: relPath, abs, lang };
			const read = lang ? await readSource(entry) : null;
			const previous = this.facts.get(relPath);
			const meta = this.manifest.files[relPath];

			if (!read) {
				if (previous) {
					delta.removedFiles.push(relPath);
					for (const decl of previous.decls) delta.removed.push(symbolId(previous.lang, relPath, decl.q || decl.n));
					this.pluckFile(relPath);
					delete this.manifest.files[relPath];
					this.scheduleSave();
				}
				continue;
			}
			if (meta && meta.h === read.hash && previous) {
				delta.unchanged.push(relPath);
				continue;
			}
			let fact;
			try {
				fact = extractFacts(relPath, lang, read.text);
			} catch (error) {
				this.log(`extract failed ${relPath}: ${error.message}`);
				this.failures.push({ path: relPath, reason: error.message });
				delta.failed.push(relPath);
				continue;
			}
			const key = meta?.k ?? hashShort(relPath);
			await this.writeFact(key, fact).catch((error) => this.log(`fact write failed ${relPath}: ${error.message}`));
			const diff = diffDecls(previous, fact, lang, relPath);
			delta.added.push(...diff.added);
			delta.removed.push(...diff.removed);
			delta.changed.push(...diff.changed);
			delta.files.push(relPath);
			this.installFact(fact);
			this.manifest.files[relPath] = { k: key, h: read.hash, m: Math.round(read.mtimeMs), s: read.size, l: lang };
			this.scheduleSave();
		}
		if (delta.files.length > 0 || delta.removedFiles.length > 0) this.generation += 1;
		return delta;
	}

	// ---- lookups ------------------------------------------------------------

	symbol(id) {
		return this.symbols.get(id);
	}

	byNameAll(name) {
		const bucket = this.byName.get(name);
		return bucket ? [...bucket].map((id) => this.symbols.get(id)).filter(Boolean) : [];
	}

	byPath(relPath) {
		const ids = this.byFile.get(relPath);
		return ids ? [...ids].map((id) => this.symbols.get(id)).filter(Boolean) : [];
	}

	declsByName(name) {
		return this.byNameAll(name);
	}

	/** Who declares `extends X` / `implements X` / `embeds X`. */
	subtypesOf(name) {
		const bucket = this.heritage.get(name);
		return bucket ? [...bucket].map((id) => this.symbols.get(id)).filter(Boolean) : [];
	}

	/** Ancestors of a symbol, following heritage names through the index. */
	ancestorsOf(id, { maxDepth = 8 } = {}) {
		const out = [];
		const seen = new Set([id]);
		let frontier = [id];
		for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
			const next = [];
			for (const current of frontier) {
				const node = this.symbols.get(current);
				if (!node) continue;
				for (const h of node.heritage) {
					for (const candidate of this.byNameAll(h.name)) {
						if (seen.has(candidate.id)) continue;
						seen.add(candidate.id);
						out.push({ ...candidate, via: h.kind, depth: depth + 1 });
						next.push(candidate.id);
					}
				}
			}
			frontier = next;
		}
		return out;
	}

	status() {
		return {
			root: this.root,
			cacheDir: this.cacheDir,
			ready: this.ready,
			generation: this.generation,
			files: this.fileCount,
			symbols: this.symbols.size,
			names: this.byName.size,
			build: this.lastBuild,
			skipped: this.failures.length,
			skippedSample: this.failures.slice(0, 5).map((f) => f.path),
			indexedAt: this.manifest.updatedAt,
		};
	}
}

function diffDecls(previous, next, lang, relPath) {
	const added = [];
	const removed = [];
	const changed = [];
	const before = new Map();
	for (const d of previous?.decls ?? []) before.set(d.q || d.n, d);
	const after = new Map();
	for (const d of next.decls ?? []) after.set(d.q || d.n, d);
	for (const [qual, decl] of after) {
		const old = before.get(qual);
		const id = symbolId(lang, relPath, qual);
		if (!old) {
			added.push(id);
			continue;
		}
		if (old.sh !== decl.sh) changed.push({ id, reason: 'signature' });
		else if (old.bh !== decl.bh) changed.push({ id, reason: 'body' });
	}
	for (const qual of before.keys()) if (!after.has(qual)) removed.push(symbolId(lang, relPath, qual));
	return { added, removed, changed };
}
