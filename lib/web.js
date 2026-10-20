/**
 * HTTP surface for the Web UI page.
 *
 * A client plugin cannot call host services directly, so the page reads the
 * index through these routes. Serving is read-only and narrow: the only roots
 * that can be read are ones this workspace already knows about (the session
 * root, or a root with a cache on disk). The one write-shaped route, `index`,
 * takes an explicit absolute path and only builds a cache for it; nothing in
 * the user's repository is ever modified.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

// The host matches a prefix route by plain string prefix, so the pattern must
// NOT end in a slash: '/x/' would need the request path to contain a double
// slash and would never match. Sub-paths are stripped in the handler instead.
const PREFIX = '/code-impact/api';
const BODY_LIMIT = 64 * 1024;

// The standalone page lives outside the API prefix, as exact routes: a second
// prefix ('/code-impact') would also swallow the API requests.
const APP_HTML = '/code-impact/app';
const APP_JS = '/code-impact/app.js';

const WEB_DIR = new URL('../web/', import.meta.url);
const STATIC = new Map([
	[APP_HTML, { file: 'app.html', type: 'text/html; charset=utf-8' }],
	[APP_JS, { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 */
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		'content-length': Buffer.byteLength(payload),
		'cache-control': 'no-store',
	});
	res.end(payload);
}

function methodNotAllowed(res, allowed) {
	sendJson(res, 405, { error: `only ${allowed.join(', ')} is supported` });
}

/** Read and parse a small JSON request body. */
function readJson(req) {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks = [];
		req.on('data', (chunk) => {
			size += chunk.length;
			if (size > BODY_LIMIT) {
				reject(Object.assign(new Error('request body is too large'), { status: 413 }));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8').trim();
			if (!text) {
				resolve({});
				return;
			}
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(Object.assign(new Error('request body is not valid JSON'), { status: 400 }));
			}
		});
		req.on('error', reject);
	});
}

/**
 * @param {{
 *   feed: import('./feed.js').FeedService,
 *   usage?: import('./usage.js').UsageLog,
 *   defaultRoot: () => Promise<string|null>,
 *   log: (message: string) => void,
 * }} options
 */
export function createWebHandler({ feed, usage, defaultRoot, log }) {
	async function allowedRoots() {
		const set = new Set();
		// Already-indexed roots first: a settings page has no session, so the
		// workspace that has an index is a better default than the profile
		// directory the host process happens to run in.
		for (const entry of await feed.roots()) set.add(path.resolve(entry.root));
		for (const root of feed.indexes.keys()) set.add(root);
		const fallback = await defaultRoot().catch(() => null);
		if (fallback) set.add(path.resolve(fallback));
		return set;
	}

	async function pickRoot(requested) {
		const allowed = await allowedRoots();
		if (requested) {
			const resolved = path.resolve(requested);
			if (!allowed.has(resolved)) throw Object.assign(new Error(`root is not indexed: ${requested}`), { status: 403 });
			return resolved;
		}
		const first = [...allowed][0];
		if (!first) throw Object.assign(new Error('no workspace is indexed yet'), { status: 404 });
		return first;
	}

	return async function handle(req, res) {
		try {
			const url = new URL(req.url ?? '/', 'http://localhost');
			const route =
				url.pathname === PREFIX || url.pathname.startsWith(`${PREFIX}/`)
					? url.pathname.slice(PREFIX.length).replace(/^\/+/, '')
					: '';
			const method = req.method ?? 'GET';

			// The only route that changes anything: build a cache for a directory
			// the user named. Everything else reads an index that already exists.
			if (method === 'POST' && route === 'index') {
				const body = await readJson(req);
				const added = await feed.addRoot(body?.root);
				log(`indexed ${added.root} (${added.files} files, ${added.symbols} symbols)`);
				sendJson(res, 200, added);
				return;
			}

			// Clearing the audit trail is the other deliberate write, and it is
			// scoped to this plugin's own records.
			if (method === 'POST' && route === 'usage/clear') {
				if (!usage) {
					sendJson(res, 404, { error: 'usage log is not available' });
					return;
				}
				const cleared = await usage.clear();
				sendJson(res, 200, cleared);
				return;
			}

			if (method !== 'GET') {
				methodNotAllowed(res, ['GET']);
				return;
			}

			if (route === 'usage') {
				if (!usage) {
					sendJson(res, 404, { error: 'usage log is not available' });
					return;
				}
				sendJson(res, 200, await usage.list({ limit: Number(url.searchParams.get('limit')) || 200 }));
				return;
			}

			if (route === 'roots') {
				const roots = await feed.roots();
				const fallback = await defaultRoot().catch(() => null);
				// The page opens with no root: hand it the freshest index, not the
				// profile directory, so the first overview is the workspace.
				const preferred = roots[0]?.root ?? fallback ?? null;
				sendJson(res, 200, { defaultRoot: preferred, roots });
				return;
			}

			if (route === 'overview') {
				const root = await pickRoot(url.searchParams.get('root'));
				const refresh = url.searchParams.get('refresh') === '1';
				const value = await feed.overview(root, { refresh });
				sendJson(res, 200, value);
				return;
			}

			if (route === 'file') {
				const root = await pickRoot(url.searchParams.get('root'));
				const relPath = url.searchParams.get('path');
				if (!relPath) {
					sendJson(res, 400, { error: 'path is required' });
					return;
				}
				const detail = await feed.fileDetail(root, relPath);
				if (!detail) {
					sendJson(res, 404, { error: `not indexed: ${relPath}` });
					return;
				}
				sendJson(res, 200, detail);
				return;
			}

			sendJson(res, 404, { error: `unknown route: ${route || '(empty)'}` });
		} catch (error) {
			const status = Number(error?.status) || 500;
			if (status >= 500) log(`web route failed: ${error?.stack ?? error}`);
			sendJson(res, status, { error: error?.message ?? String(error) });
		}
	};
}

/**
 * Serve one file from the package's `web/` directory. Read on every request so
 * editing the page does not need a plugin reload; the files are tiny.
 * @param {{ file: string, type: string }} entry
 */
export function createStaticHandler(entry, { log } = {}) {
	return async function handle(req, res) {
		try {
			const body = await fs.readFile(new URL(entry.file, WEB_DIR));
			res.writeHead(200, {
				'content-type': entry.type,
				'content-length': body.length,
				'cache-control': 'no-store',
			});
			res.end(body);
		} catch (error) {
			log?.(`static ${entry.file} failed: ${error?.message ?? error}`);
			sendJson(res, 500, { error: `cannot read ${entry.file}` });
		}
	};
}

/**
 * Register the routes on the host web server when one is available.
 * @returns {(() => void) | null} disposer, or null when this host has no web server.
 */
export function registerWebRoutes(ctx, options) {
	let webServer;
	try {
		webServer = ctx.get('webServer');
	} catch (error) {
		options.log(`webServer unavailable: ${error?.message ?? error}`);
		return null;
	}
	if (!webServer || typeof webServer.register !== 'function') return null;
	const disposers = [];
	try {
		disposers.push(
			webServer.register({
				kind: 'prefix',
				path: PREFIX,
				handler: createWebHandler(options),
			}),
		);
		for (const [route, entry] of STATIC) {
			disposers.push(
				webServer.register({
					kind: 'exact',
					path: route,
					handler: createStaticHandler(entry, options),
				}),
			);
		}
	} catch (error) {
		options.log(`failed to register ${PREFIX}: ${error?.message ?? error}`);
		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch {
				/* a route we could not register is not worth a second failure */
			}
		}
		return null;
	}
	return () => {
		for (const dispose of disposers) {
			try {
				dispose?.();
			} catch {
				/* dispose is best effort during teardown */
			}
		}
	};
}
