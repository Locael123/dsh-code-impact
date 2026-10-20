/**
 * The usage ledger: which sessions used this plugin, what they asked, and what
 * came back.
 *
 * This is deliberately not a log of every tool call in the harness — it is the
 * plugin's own audit trail, written by the two tools it owns. Keeping it here
 * (rather than reading the session store) means it survives a restart, works
 * for sessions this process never saw, and cannot be mistaken for an authority
 * on what the agent did.
 *
 * Records are cheap and bounded: one line per call, capped per session and in
 * total, flushed on a debounce so a burst of queries does not turn into a burst
 * of disk writes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

export const USAGE_VERSION = 1;

const MAX_EVENTS_PER_SESSION = 200;
const MAX_SESSIONS = 100;
const MAX_TARGET = 160;
const MAX_OUTCOME = 200;
const SAVE_DEBOUNCE_MS = 600;

function clip(value, max) {
	const s = String(value ?? '');
	return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function emptyLedger() {
	return { version: USAGE_VERSION, updatedAt: 0, sessions: [] };
}

export class UsageLog {
	/**
	 * @param {{ file: string, log?: (message: string) => void }} options
	 */
	constructor(options) {
		this.file = options.file;
		this.log = options.log ?? (() => {});
		/** @type {ReturnType<typeof emptyLedger>|null} */
		this.data = null;
		this.timer = null;
		this.saving = null;
	}

	async load() {
		if (this.data) return this.data;
		try {
			const raw = await fs.readFile(this.file, 'utf8');
			const parsed = JSON.parse(raw);
			if (parsed?.version === USAGE_VERSION && Array.isArray(parsed.sessions)) {
				this.data = { version: USAGE_VERSION, updatedAt: Number(parsed.updatedAt) || 0, sessions: parsed.sessions };
				return this.data;
			}
			this.log(`usage ledger has an unknown version; starting a new one`);
		} catch (error) {
			if (error?.code !== 'ENOENT') this.log(`usage ledger unreadable: ${error?.message ?? error}`);
		}
		this.data = emptyLedger();
		return this.data;
	}

	/**
	 * One tool call.
	 * @param {{ session?: string|null, cwd?: string|null, root?: string|null, tool: string, op?: string|null, target?: string|null, outcome?: string|null }} entry
	 */
	async record(entry) {
		const data = await this.load();
		const now = Date.now();
		const id = String(entry.session ?? '').trim() || 'unattributed';
		let session = data.sessions.find((s) => s.id === id);
		if (!session) {
			session = { id, cwd: entry.cwd ?? null, firstAt: now, lastAt: now, calls: {}, events: [] };
			data.sessions.unshift(session);
		}
		if (entry.cwd && session.cwd !== entry.cwd) session.cwd = entry.cwd;
		session.lastAt = now;
		session.calls[entry.tool] = (session.calls[entry.tool] ?? 0) + 1;
		session.events.push({
			at: now,
			tool: entry.tool,
			op: entry.op ?? null,
			target: clip(entry.target, MAX_TARGET),
			outcome: clip(entry.outcome, MAX_OUTCOME),
			root: entry.root ?? null,
		});
		if (session.events.length > MAX_EVENTS_PER_SESSION) {
			session.events.splice(0, session.events.length - MAX_EVENTS_PER_SESSION);
		}
		// Newest session first; the cap drops the coldest tail rather than the
		// session that is being written right now.
		data.sessions.sort((a, b) => b.lastAt - a.lastAt);
		if (data.sessions.length > MAX_SESSIONS) data.sessions.length = MAX_SESSIONS;
		data.updatedAt = now;
		this.schedule();
		return session;
	}

	/** Everything the page needs, already ordered by recency. */
	async list({ limit = 200, session = null } = {}) {
		const data = await this.load();
		const sessions = session ? data.sessions.filter((s) => s.id === session) : data.sessions;
		let calls = 0;
		let events = 0;
		for (const s of sessions) {
			for (const n of Object.values(s.calls ?? {})) calls += Number(n) || 0;
			events += s.events?.length ?? 0;
		}
		return {
			version: USAGE_VERSION,
			updatedAt: data.updatedAt,
			totals: { sessions: sessions.length, calls, events },
			sessions: sessions.slice(0, limit).map((s) => ({
				...s,
				events: (s.events ?? []).slice(-40).reverse(),
			})),
		};
	}

	async clear() {
		this.data = emptyLedger();
		this.data.updatedAt = Date.now();
		this.cancel();
		await this.write();
		return { ok: true };
	}

	schedule() {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.write().catch((error) => this.log(`usage ledger write failed: ${error?.message ?? error}`));
		}, SAVE_DEBOUNCE_MS);
		if (typeof this.timer?.unref === 'function') this.timer.unref();
	}

	cancel() {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	async write() {
		if (!this.data) return;
		const payload = JSON.stringify(this.data);
		const dir = path.dirname(this.file);
		const tmp = path.join(dir, `.usage-${process.pid}-${Date.now()}.tmp`);
		try {
			await fs.mkdir(dir, { recursive: true });
			await fs.writeFile(tmp, payload, 'utf8');
			await fs.rename(tmp, this.file);
		} catch (error) {
			await fs.rm(tmp, { force: true }).catch(() => {});
			throw error;
		}
	}

	/** Flush any pending debounce. Teardown and tests use this. */
	async flush() {
		this.cancel();
		await this.write().catch((error) => this.log(`usage ledger write failed: ${error?.message ?? error}`));
	}
}
