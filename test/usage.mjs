// The usage ledger: what the tools answered, per session, and the two routes
// that expose it. Runs against a real file in a temp directory.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UsageLog } from '../lib/usage.js';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsh-code-impact-usage-'));
const file = path.join(dir, 'usage.json');

const log = new UsageLog({ file });
await log.load();

assert.deepEqual(await log.list(), {
	version: 1,
	updatedAt: 0,
	totals: { sessions: 0, calls: 0, events: 0 },
	sessions: [],
}, 'an empty ledger lists no sessions');

await log.record({ session: 's1', cwd: 'D:\\proj', tool: 'code_query', op: 'find', target: 'parseTimeout', outcome: '1 match' });
await log.record({ session: 's1', cwd: 'D:\\proj', tool: 'code_query', op: 'refs', target: 'parseTimeout', outcome: '3 sites, 0 unresolved' });
await log.record({ session: 's2', cwd: 'D:\\other', tool: 'code_verify', op: 'verify', target: 'every changed file', outcome: 'verdict clean' });

let listed = await log.list();
assert.equal(listed.totals.sessions, 2);
assert.equal(listed.totals.calls, 3);
assert.equal(listed.totals.events, 3);
assert.deepEqual(listed.sessions.map((s) => s.id), ['s2', 's1'], 'the most recent session comes first');
const s1 = listed.sessions.find((s) => s.id === 's1');
assert.deepEqual(s1.calls, { code_query: 2 });
assert.equal(s1.events.length, 2);
assert.equal(s1.events[0].target, 'parseTimeout', 'events are newest first');
assert.equal(s1.cwd, 'D:\\proj');

// One session only, when asked.
listed = await log.list({ session: 's1' });
assert.equal(listed.sessions.length, 1);

// It survives a restart: the file is written, and a second instance reads it.
await log.flush();
const reread = new UsageLog({ file });
await reread.load();
assert.equal((await reread.list()).totals.calls, 3);

// Clearing empties the ledger and the file.
await log.clear();
assert.equal((await log.list()).totals.calls, 0);
const onDisk = JSON.parse(await fs.readFile(file, 'utf8'));
assert.equal(onDisk.version, 1);
assert.deepEqual(onDisk.sessions, []);

// A corrupt file must not take the host down.
await fs.writeFile(file, '{ not json', 'utf8');
const broken = new UsageLog({ file });
await broken.load();
assert.equal((await broken.list()).totals.calls, 0, 'a corrupt ledger starts empty');

await fs.rm(dir, { recursive: true, force: true });
console.log('usage ok — records, lists per session, persists, clears, survives corruption');
