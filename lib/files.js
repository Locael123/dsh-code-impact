/**
 * Workspace walking and small file helpers.
 *
 * The index never writes into a user repository and never follows a directory
 * it was told to skip. Skipping is a correctness feature, not an optimisation:
 * vendored and generated trees would otherwise dominate every answer.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, sep } from 'node:path';

export const MAX_FILE_BYTES = 512 * 1024;

/** Directory names never descended into. */
export const SKIP_DIRS = new Set([
	'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
	'vendor', '__pycache__', '.venv', 'venv', 'coverage', '.next', '.nuxt',
	'.cache', '.turbo', '.idea', '.vscode', '.dsh', '.avis', 'tmp', 'temp',
	'bin', 'obj', 'Pods', 'DerivedData',
]);

export const LANG_BY_EXT = new Map([
	['.ts', 'ts'], ['.tsx', 'ts'], ['.mts', 'ts'], ['.cts', 'ts'],
	['.js', 'js'], ['.jsx', 'js'], ['.mjs', 'js'], ['.cjs', 'js'],
	['.go', 'go'],
]);

/** Extensions tried, in order, when resolving a JS/TS import specifier. */
export const JS_RESOLVE_EXTENSIONS = [
	'.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json',
];

export function toPosix(p) {
	return sep === '/' ? p : p.split(sep).join('/');
}

export function hashText(text) {
	return createHash('sha1').update(text).digest('hex');
}

export function hashShort(text) {
	return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

export function langOf(path) {
	return LANG_BY_EXT.get(extname(path).toLowerCase()) ?? null;
}

function looksMinified(text) {
	const firstNl = text.indexOf('\n');
	const head = firstNl === -1 ? text : text.slice(0, firstNl);
	return head.length > 2000 && firstNl > -1 && text.length / (text.split('\n').length || 1) > 400;
}

function looksBinary(buf) {
	const probe = Math.min(buf.length, 8000);
	for (let i = 0; i < probe; i += 1) if (buf[i] === 0) return true;
	return false;
}

export function isTestPath(relPath) {
	return (
		/(^|\/)(__tests__|__mocks__|tests?|spec|e2e)\//.test(relPath) ||
		/\.(test|spec)\.(?:[cm]?[jt]sx?)$/.test(relPath) ||
		/_test\.go$/.test(relPath) ||
		/(^|\/)test_[^/]+\.py$/.test(relPath)
	);
}

/**
 * Walk the workspace and yield indexable source files.
 * @param {string} root absolute, real workspace root
 * @param {{ maxFiles?: number, signal?: AbortSignal, onSkip?: (dir: string) => void }} [options]
 */
export async function walkSourceFiles(root, options = {}) {
	const maxFiles = options.maxFiles ?? 20000;
	const out = [];
	const stack = [root];
	while (stack.length > 0) {
		if (options.signal?.aborted) break;
		const dir = stack.pop();
		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) {
					options.onSkip?.(full);
					continue;
				}
				if (entry.name.startsWith('.') && entry.name !== '.github') continue;
				stack.push(full);
				continue;
			}
			if (!entry.isFile()) continue;
			const lang = langOf(entry.name);
			if (lang === null) continue;
			if (/\.min\.[cm]?js$/.test(entry.name)) continue;
			out.push({ path: toPosix(relative(root, full)), abs: full, lang });
			if (out.length >= maxFiles) return out;
		}
	}
	return out;
}

/**
 * Read one file, returning null when it is too large, binary, minified, or gone.
 * @param {{ abs: string, path: string, lang: string }} entry
 */
export async function readSource(entry) {
	let info;
	try {
		info = await stat(entry.abs);
	} catch {
		return null;
	}
	if (!info.isFile() || info.size === 0 || info.size > MAX_FILE_BYTES) return null;
	let buf;
	try {
		buf = await readFile(entry.abs);
	} catch {
		return null;
	}
	if (looksBinary(buf)) return null;
	const text = buf.toString('utf8');
	if (looksMinified(text)) return null;
	return { text, size: info.size, mtimeMs: info.mtimeMs, hash: hashShort(text) };
}

/**
 * Run `worker` over `items` with bounded concurrency, preserving input order.
 * @template T, R
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<R>} worker
 * @returns {Promise<R[]>}
 */
export async function mapLimit(items, limit, worker) {
	const results = new Array(items.length);
	let cursor = 0;
	const runners = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
		for (;;) {
			const index = cursor;
			cursor += 1;
			if (index >= items.length) return;
			results[index] = await worker(items[index], index);
		}
	});
	await Promise.all(runners);
	return results;
}
