// Proves the page's "index a folder" path works without the web server:
// FeedService.addRoot must refuse bad paths and build a real index for a good one.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { FeedService } from '../lib/feed.js';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ci-addroot-'));
const feed = new FeedService({ cacheRoot });

const target = path.resolve(here, 'fixture');

const added = await feed.addRoot(target);
assert.equal(path.resolve(added.root), target);
assert.ok(added.files >= 5, `expected the fixture files, got ${added.files}`);
assert.ok(added.symbols > 10, `expected symbols, got ${added.symbols}`);
assert.equal(added.skipped, 0);

const listed = await feed.roots();
assert.equal(listed.length, 1);
assert.equal(path.resolve(listed[0].root), target);

// Same root twice is not a second workspace.
const again = await feed.addRoot(target);
assert.equal(again.files, added.files);
assert.equal((await feed.roots()).length, 1);

// A relative path is refused: the page must not index whatever the process cwd is.
await assert.rejects(() => feed.addRoot('fixture'), /absolute path/);
// A missing directory is refused with the path in the message.
await assert.rejects(() => feed.addRoot(path.join(target, 'nope')), /no such directory/);
// A file is not a directory.
await assert.rejects(() => feed.addRoot(path.join(target, 'src', 'config.ts')), /not a directory/);

const overview = await feed.overview(target);
assert.equal(overview.files.length, added.files);

await fs.rm(cacheRoot, { recursive: true, force: true });
console.log(`addRoot ok — ${added.files} files, ${added.symbols} symbols, ${overview.edges.length} edges`);
