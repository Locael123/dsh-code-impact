import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { FeedService } from '../lib/feed.js';
import { createWebHandler } from '../lib/web.js';

const cacheRoot = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'cache', 'code-index');
const root = process.argv[2] ?? process.cwd();

const feed = new FeedService({ cacheRoot, log: (m) => console.log('[feed]', m) });
const payload = await feed.overview(root);
console.log('root', payload.root);
console.log('status', JSON.stringify(payload.status));
console.log('dirs', payload.dirs.length, 'files', payload.files.length, 'edges', payload.edges.length, 'types', payload.types.length);
console.log('sample dirs', payload.dirs.slice(0, 5));
console.log('sample files', payload.files.slice(0, 5));
console.log('sample edges', payload.edges.slice(0, 5));
console.log('sample types', payload.types.slice(0, 3));

const server = http.createServer(
	createWebHandler({ feed, defaultRoot: async () => root, log: (m) => console.log('[web]', m) }),
);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const base = `http://127.0.0.1:${port}/code-impact/api`;

for (const route of ['roots', 'overview', 'file?path=lib/feed.js', 'nope']) {
	const response = await fetch(`${base}/${route}`);
	const body = await response.text();
	console.log(route, response.status, body.slice(0, 240).replace(/\n/g, ' '));
}
server.close();
