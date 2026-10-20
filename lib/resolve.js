/**
 * Name resolution: from "this file mentions `parseTimeout`" to "that is
 * src/config.ts#parseTimeout".
 *
 * Facts never store a target, so this is where meaning is produced. The order
 * is the compiler's order: local parameters shadow, then module scope, then the
 * import table, then the project's path aliases, then a unique-name guess. Every
 * answer carries a confidence so callers can tell proof from guesswork.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { toPosix } from './files.js';

const JS_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

function posixDir(p) {
	const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
	return dir;
}

function normalizePosix(p) {
	const parts = [];
	for (const segment of p.split('/')) {
		if (!segment || segment === '.') continue;
		if (segment === '..') {
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.join('/');
}

function stripJsonComments(text) {
	let out = '';
	let inString = false;
	let inLine = false;
	let inBlock = false;
	for (let i = 0; i < text.length; i += 1) {
		const ch = text[i];
		const next = text[i + 1];
		if (inLine) {
			if (ch === '\n') {
				inLine = false;
				out += ch;
			}
			continue;
		}
		if (inBlock) {
			if (ch === '*' && next === '/') {
				inBlock = false;
				i += 1;
			}
			continue;
		}
		if (inString) {
			out += ch;
			if (ch === '\\') {
				out += next ?? '';
				i += 1;
			} else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') {
			inString = true;
			out += ch;
			continue;
		}
		if (ch === '/' && next === '/') {
			inLine = true;
			i += 1;
			continue;
		}
		if (ch === '/' && next === '*') {
			inBlock = true;
			i += 1;
			continue;
		}
		out += ch;
	}
	return out.replace(/,\s*([}\]])/g, '$1');
}

export class Resolver {
	/**
	 * @param {import('./store.js').CodeIndex} index
	 */
	constructor(index) {
		this.index = index;
		this.cache = new Map();
		this.generation = -1;
		this.tsconfig = { baseUrl: '', paths: [] };
		this.goModule = '';
		this.configsLoaded = false;
	}

	async loadConfigs() {
		if (this.configsLoaded) return;
		this.configsLoaded = true;
		const root = this.index.root;
		for (const name of ['tsconfig.json', 'jsconfig.json']) {
			try {
				const raw = await fs.readFile(path.join(root, name), 'utf8');
				const parsed = JSON.parse(stripJsonComments(raw));
				const options = parsed.compilerOptions ?? {};
				this.tsconfig = {
					baseUrl: normalizePosix(options.baseUrl ?? ''),
					paths: Object.entries(options.paths ?? {}).map(([pattern, targets]) => ({ pattern, targets })),
				};
				break;
			} catch {
				/* keep looking */
			}
		}
		try {
			const raw = await fs.readFile(path.join(root, 'go.mod'), 'utf8');
			const m = /^\s*module\s+(\S+)/m.exec(raw);
			if (m) this.goModule = m[1];
		} catch {
			/* no go module */
		}
	}

	ensureGeneration() {
		if (this.generation !== this.index.generation) {
			this.cache.clear();
			this.generation = this.index.generation;
		}
	}

	// ---- module resolution --------------------------------------------------

	/** Resolve an import specifier from a file to an indexed path. */
	resolveModule(fromPath, spec) {
		if (!spec) return null;
		if (fromPath.endsWith('.go')) return this.resolveGoImport(spec);
		if (spec.startsWith('.')) return this.resolveRelative(fromPath, spec);
		const alias = this.matchAlias(spec);
		if (alias) return alias;
		const base = this.tsconfig.baseUrl ? normalizePosix(`${this.tsconfig.baseUrl}/${spec}`) : '';
		if (base) {
			const hit = this.firstExisting(this.candidatePaths(base));
			if (hit) return { path: hit, confidence: 'resolved' };
		}
		return { external: true, spec, package: spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0] };
	}

	candidatePaths(base) {
		const out = [];
		if (/\.[cm]?[jt]sx?$/.test(base)) {
			out.push(base);
			if (base.endsWith('.js')) {
				for (const ext of ['.ts', '.tsx']) out.push(base.slice(0, -3) + ext);
			}
			if (base.endsWith('.mjs')) out.push(`${base.slice(0, -4)}.mts`);
			if (base.endsWith('.cjs')) out.push(`${base.slice(0, -4)}.cts`);
			out.push(base.replace(/\.js$/, '.ts'));
		} else {
			for (const ext of JS_EXTS) out.push(`${base}${ext}`);
			for (const ext of JS_EXTS) out.push(`${base}/index${ext}`);
		}
		return out;
	}

	firstExisting(candidates) {
		for (const candidate of candidates) {
			if (this.index.facts.has(candidate)) return candidate;
		}
		return null;
	}

	resolveRelative(fromPath, spec) {
		const dir = posixDir(fromPath);
		const base = normalizePosix(`${dir}/${spec}`);
		const hit = this.firstExisting(this.candidatePaths(base));
		if (hit) return { path: hit, confidence: 'exact' };
		return null;
	}

	matchAlias(spec) {
		let best = null;
		for (const { pattern, targets } of this.tsconfig.paths) {
			const star = pattern.indexOf('*');
			if (star === -1) {
				if (pattern === spec) {
					for (const target of targets) {
						const hit = this.firstExisting(this.candidatePaths(normalizePosix(target)));
						if (hit) return { path: hit, confidence: 'resolved' };
					}
				}
				continue;
			}
			const prefix = pattern.slice(0, star);
			const suffix = pattern.slice(star + 1);
			if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
			const middle = spec.slice(prefix.length, spec.length - suffix.length);
			if (best && best.prefix.length >= prefix.length) continue;
			for (const target of targets) {
				const substituted = normalizePosix(target.replace('*', middle));
				const hit = this.firstExisting(this.candidatePaths(substituted));
				if (hit) return { path: hit, confidence: 'resolved' };
				best = { prefix, hit: null };
			}
		}
		return null;
	}

	/** Go: import path -> directory, via go.mod module prefix. */
	resolveGoImport(spec) {
		let rel = null;
		if (this.goModule && spec === this.goModule) rel = '';
		else if (this.goModule && spec.startsWith(`${this.goModule}/`)) rel = spec.slice(this.goModule.length + 1);
		else if (!spec.includes('.') && !this.goModule) rel = spec;
		if (rel === null) return { external: true, spec, package: spec };
		const dir = normalizePosix(rel);
		const files = this.goFilesIn(dir);
		if (files.length === 0) return null;
		return { dir, files, confidence: 'exact' };
	}

	goFilesIn(dir) {
		const prefix = dir ? `${dir}/` : '';
		const out = [];
		for (const [relPath, fact] of this.index.facts) {
			if (fact.lang !== 'go' || !relPath.startsWith(prefix)) continue;
			const rest = relPath.slice(prefix.length);
			if (rest.includes('/')) continue;
			if (rest.endsWith('_test.go')) continue;
			out.push(relPath);
		}
		return out;
	}

	// ---- name resolution ----------------------------------------------------

	/**
	 * Resolve a name mentioned in `fromPath`.
	 * @returns {{ targets: {node: any, confidence: string}[], reason: string }}
	 */
	resolveName(fromPath, name, options = {}) {
		this.ensureGeneration();
		const via = options.via;
		const ownerId = options.owner;
		const key = `${fromPath}\u0000${via ?? ''}\u0000${name}`;
		const cached = this.cache.get(key);
		if (cached) return cached;

		const result = fromPath.endsWith('.go')
			? this.resolveGoName(fromPath, name, via)
			: this.resolveJsName(fromPath, name, via, ownerId);
		this.cache.set(key, result);
		return result;
	}

	resolveJsName(fromPath, name, via, ownerId) {
		const fact = this.index.facts.get(fromPath);
		if (!fact) return { targets: [], reason: 'unknown-file' };

		// 1. parameters of the enclosing declaration shadow everything
		if (ownerId) {
			const owner = this.index.symbol(ownerId);
			if (owner?.params?.some((p) => p.n === name)) return { targets: [], reason: 'local' };
		}

		// 2. same file, module scope
		const local = (fact.decls ?? []).filter((d) => d.n === name);
		if (local.length > 0) {
			const decl = local.find((d) => d.p === -1) ?? local[0];
			const id = `${fact.lang}:${fromPath}#${decl.q || decl.n}`;
			const node = this.index.symbol(id);
			if (node) return { targets: [{ node, confidence: 'exact' }], reason: 'same-file' };
		}

		// 3. namespace member: `ns.Name`
		if (via) {
			const nsImport = (fact.imports ?? []).find((im) => im.local === via);
			if (nsImport) {
				const mod = this.resolveModule(fromPath, nsImport.from);
				if (mod?.path) {
					const target = this.findExport(mod.path, name);
					if (target) return { targets: [{ node: target, confidence: 'resolved' }], reason: 'namespace' };
				}
			}
			return { targets: [], reason: 'namespace-miss' };
		}

		// 4. named import
		const named = (fact.imports ?? []).filter((im) => im.local === name && im.kind !== 'namespace');
		for (const im of named) {
			const mod = this.resolveModule(fromPath, im.from);
			if (mod?.path) {
				const target = this.findExport(mod.path, im.imported === 'default' ? 'default' : im.imported);
				if (target) return { targets: [{ node: target, confidence: 'exact' }], reason: 'import' };
			}
		}

		// 5. unique name anywhere (heuristic, then ambiguous)
		const candidates = this.index.byNameAll(name).filter((node) => node.lang === fact.lang && node.kind !== 'field');
		if (candidates.length === 1) return { targets: [{ node: candidates[0], confidence: 'heuristic' }], reason: 'unique-name' };
		if (candidates.length > 1) {
			const scored = candidates
				.map((node) => ({ node, score: this.proximityScore(fromPath, node.path) }))
				.sort((a, b) => b.score - a.score);
			const top = scored.filter((s) => s.score === scored[0].score);
			if (top.length === 1) return { targets: [{ node: top[0].node, confidence: 'heuristic' }], reason: 'closest-name' };
			return { targets: top.slice(0, 5).map((s) => ({ node: s.node, confidence: 'ambiguous' })), reason: 'ambiguous' };
		}
		return { targets: [], reason: 'unresolved' };
	}

	resolveGoName(fromPath, name, via) {
		const fact = this.index.facts.get(fromPath);
		if (!fact) return { targets: [], reason: 'unknown-file' };
		const dir = posixDir(fromPath);
		const importRef = via ?? null;

		if (importRef) {
			const im = (fact.imports ?? []).find((entry) => entry.local === importRef);
			if (im) {
				const mod = this.resolveGoImport(im.from);
				if (mod?.files) {
					for (const file of mod.files) {
						const node = this.topLevelDecl(file, name);
						if (node) return { targets: [{ node, confidence: 'exact' }], reason: 'package-qualified' };
					}
				}
			}
			return { targets: [], reason: 'package-miss' };
		}

		// same package directory
		for (const [relPath, other] of this.index.facts) {
			if (other.lang !== 'go' || posixDir(relPath) !== dir) continue;
			const node = this.topLevelDecl(relPath, name);
			if (node) return { targets: [{ node, confidence: 'exact' }], reason: 'same-package' };
		}

		const candidates = this.index.byNameAll(name).filter((node) => node.lang === 'go' && node.kind !== 'field');
		if (candidates.length === 1) return { targets: [{ node: candidates[0], confidence: 'heuristic' }], reason: 'unique-name' };
		if (candidates.length > 1) {
			const scored = candidates
				.map((node) => ({ node, score: this.proximityScore(fromPath, node.path) }))
				.sort((a, b) => b.score - a.score);
			const top = scored.filter((s) => s.score === scored[0].score);
			if (top.length === 1) return { targets: [{ node: top[0].node, confidence: 'heuristic' }], reason: 'closest-name' };
			return { targets: top.slice(0, 5).map((s) => ({ node: s.node, confidence: 'ambiguous' })), reason: 'ambiguous' };
		}
		return { targets: [], reason: 'unresolved' };
	}

	topLevelDecl(relPath, name) {
		const fact = this.index.facts.get(relPath);
		if (!fact) return null;
		const decl = (fact.decls ?? []).find((d) => d.p === -1 && d.n === name);
		if (!decl) return null;
		return this.index.symbol(`${fact.lang}:${relPath}#${decl.q || decl.n}`) ?? null;
	}

	/** Find what `name` refers to inside `relPath`, considering re-exports. */
	findExport(relPath, name, depth = 0) {
		if (depth > 4) return null;
		const fact = this.index.facts.get(relPath);
		if (!fact) return null;
		if (name === 'default') {
			const explicit = (fact.exports ?? []).find((e) => e.exported === 'default');
			if (explicit?.local) {
				const decl = (fact.decls ?? []).find((d) => d.n === explicit.local);
				if (decl) return this.index.symbol(`${fact.lang}:${relPath}#${decl.q || decl.n}`) ?? null;
			}
			const defaults = (fact.exports ?? []).filter((e) => e.kind === 'default');
			if (defaults.length === 1) {
				const decl = (fact.decls ?? []).find((d) => d.n === defaults[0].local);
				if (decl) return this.index.symbol(`${fact.lang}:${relPath}#${decl.q || decl.n}`) ?? null;
			}
			const exportedDecls = (fact.decls ?? []).filter((d) => d.x === 1 && d.p === -1);
			if (exportedDecls.length === 1) {
				const decl = exportedDecls[0];
				return this.index.symbol(`${fact.lang}:${relPath}#${decl.q || decl.n}`) ?? null;
			}
			return null;
		}
		const direct = (fact.decls ?? []).find((d) => (d.q || d.n) === name || d.n === name);
		if (direct) return this.index.symbol(`${fact.lang}:${relPath}#${direct.q || direct.n}`) ?? null;
		const reexport = (fact.exports ?? []).find((e) => e.exported === name && e.from);
		if (reexport) {
			const mod = this.resolveModule(relPath, reexport.from);
			if (mod?.path) return this.findExport(mod.path, reexport.imported ?? name, depth + 1);
		}
		const star = (fact.exports ?? []).find((e) => e.star);
		if (star) {
			const mod = this.resolveModule(relPath, star.from);
			if (mod?.path) {
				const hit = this.findExport(mod.path, name, depth + 1);
				if (hit) return hit;
			}
		}
		return null;
	}

	proximityScore(fromPath, targetPath) {
		if (fromPath === targetPath) return 100;
		const a = posixDir(fromPath).split('/');
		const b = posixDir(targetPath).split('/');
		let common = 0;
		while (common < a.length && common < b.length && a[common] === b[common]) common += 1;
		let score = common * 10;
		if (isTestLike(targetPath)) score -= 5;
		return score;
	}
}

function isTestLike(p) {
	return /(^|\/)(test|tests|__tests__|spec)\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/** Is this specifier inside the workspace, or an external package? */
export function isExternalSpec(spec) {
	if (!spec) return true;
	if (spec.startsWith('.') || spec.startsWith('/')) return false;
	return true;
}

export { normalizePosix, posixDir, stripJsonComments, toPosix };
