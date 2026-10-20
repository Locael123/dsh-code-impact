/**
 * dsh-code-impact — a workspace symbol index for the harness.
 *
 * The point is not to have a database of code. The point is that after a small
 * edit the agent can ask "what did this touch?" and get an answer in one call
 * instead of re-reading the repository. So the index is a cache: disposable,
 * rebuildable, and always re-validated against the disk before it is trusted.
 */

import os from 'node:os';
import path from 'node:path';

import { FeedService } from './lib/feed.js';
import { hashShort, toPosix } from './lib/files.js';
import { CodeQuery } from './lib/query.js';
import { CodeIndex } from './lib/store.js';
import { createTools } from './lib/tools.js';
import { registerWebRoutes } from './lib/web.js';

export const name = 'dsh-code-impact';
export const inject = ['tools'];

const PROMPT = [
	'Workspace symbol index is available as code_query (find / outline / refs / hierarchy / search / status) and code_verify.',
	'Before changing a symbol that other files might use — signature, export, rename, delete — call code_query refs or hierarchy first; it is one call and it replaces a grep plus a pile of reads.',
	'After editing, call code_verify instead of re-scanning the repository. Treat its `unverified:` line as a real limit: if it says a check was not modelled, say so rather than implying the edit is proven safe.',
].join(' ');

function dshHome() {
	return process.env.DSH_HOME || process.env.DSH_PROFILE_DIR || path.join(os.homedir(), '.dsh');
}

export function apply(ctx, config = {}) {
	const log = (message) => {
		try {
			ctx.logger?.debug?.(`[dsh-code-impact] ${message}`);
		} catch {
			/* logging must never break a tool call */
		}
	};

	/** @type {{ root: string|null, index: any, query: any, initError: string|null, initializing: Promise<void>|null }} */
	const state = { root: null, index: null, query: null, initError: null, initializing: null };

	// The Web UI page reads the same index the tools use, through HTTP routes.
	// One feed per plugin instance, so an edit the tools already applied shows up
	// in the page without a rebuild of its own.
	const feed = new FeedService({ cacheRoot: path.join(dshHome(), 'cache', 'code-index'), log });

	async function resolveRoot(exec) {
		if (config.root) return path.resolve(String(config.root));
		try {
			const wd = ctx.get('workingDirectory');
			if (wd && typeof wd.ensure === 'function') {
				const value = await wd.ensure(exec?.agent, exec?.signal);
				const candidate =
					typeof value === 'string' ? value : value?.path ?? value?.root ?? value?.cwd ?? value?.displayPath ?? null;
				if (typeof candidate === 'string' && candidate.length > 0) return path.resolve(candidate);
			}
		} catch (error) {
			log(`workingDirectory unavailable: ${error?.message ?? error}`);
		}
		return process.cwd();
	}

	async function ensureReady(exec) {
		if (state.index) return;
		if (state.initializing) {
			await state.initializing;
			return;
		}
		state.initializing = (async () => {
			const root = await resolveRoot(exec);
			const cacheDir = path.join(dshHome(), 'cache', 'code-index', hashShort(`v1|${toPosix(root)}`));
			const index = new CodeIndex({
				root,
				cacheDir,
				maxFiles: Number(config.maxFiles) || 20000,
				log,
			});
			const query = new CodeQuery(index);
			await index.ensure({ signal: exec?.signal });
			await query.resolver.loadConfigs();
			state.root = root;
			state.index = index;
			state.query = query;
			feed.indexes.set(path.resolve(root), index);
			log(`index ready at ${root} (${index.symbolCount} symbols, ${index.fileCount} files)`);
		})();
		try {
			await state.initializing;
		} catch (error) {
			state.initError = error?.message ?? String(error);
			state.initializing = null;
			throw error;
		}
	}

	const service = {
		get index() {
			return state.index;
		},
		get query() {
			return state.query;
		},
		ensureReady,
	};

	for (const definition of createTools(service)) {
		try {
			ctx.tools.register(definition);
		} catch (error) {
			log(`failed to register ${definition.name}: ${error?.message ?? error}`);
		}
	}

	// A short rule in the system prompt is what makes the tools get used at the
	// moment they matter; without it, agents keep grepping out of habit.
	try {
		const prompt = ctx.systemPrompt;
		if (prompt && typeof prompt.section === 'function') {
			prompt.section({ name: 'dsh-code-impact', order: 40, text: PROMPT });
		}
	} catch (error) {
		log(`systemPrompt unavailable: ${error?.message ?? error}`);
	}

	// The page asks for "the workspace" with no argument, so the plugin needs a
	// default even before the first tool call: the session root if we have one,
	// else the profile's default directory, else wherever the host was launched.
	async function defaultRoot() {
		if (state.root) return state.root;
		if (config.root) return path.resolve(String(config.root));
		try {
			const wd = ctx.get('workingDirectory');
			const declared = wd?.defaultDirectory;
			if (typeof declared === 'string' && declared.length > 0) return path.resolve(declared);
		} catch (error) {
			log(`workingDirectory unavailable: ${error?.message ?? error}`);
		}
		return path.resolve(process.cwd());
	}

	try {
		const dispose = registerWebRoutes(ctx, { feed, defaultRoot, log });
		if (dispose) {
			ctx.effect(() => dispose);
			log('web routes registered at /code-impact/api/');
		}
	} catch (error) {
		log(`web routes unavailable: ${error?.message ?? error}`);
	}
}
