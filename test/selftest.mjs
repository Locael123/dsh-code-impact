/**
 * Self-test: builds a real index over a temp copy of test/fixture, then checks
 * the questions the tool exists to answer — including the two that matter most:
 * a body-only edit must not be reported as a contract change, and a renamed
 * export must surface its now-dangling references.
 *
 * Run: node test/selftest.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractJsTs } from '../lib/lang-js.js';
import { CodeQuery } from '../lib/query.js';
import { CodeIndex } from '../lib/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixture');

let passed = 0;
let failed = 0;

function check(label, fn) {
	try {
		fn();
		passed += 1;
		console.log(`  ok   ${label}`);
	} catch (error) {
		failed += 1;
		console.log(`  FAIL ${label}\n         ${error.message.split('\n').join('\n         ')}`);
	}
}

async function main() {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'code-intel-'));
	await fs.cp(fixture, root, { recursive: true });
	const cacheDir = path.join(root, '.cache');

	const index = new CodeIndex({ root, cacheDir, log: (m) => console.log(`  log  ${m}`) });
	const query = new CodeQuery(index);

	const started = Date.now();
	await index.ensure();
	await query.resolver.loadConfigs();
	console.log(`\nbuilt: ${index.fileCount} files, ${index.symbolCount} symbols in ${Date.now() - started}ms\n`);

	check('indexes the source files', () => assert.ok(index.fileCount >= 5, `only ${index.fileCount} files`));
	check('sees both languages', () => {
		const langs = new Set([...index.facts.values()].map((f) => f.lang));
		assert.ok(langs.has('ts') && langs.has('go'), [...langs].join(','));
	});
	check('nothing was silently skipped', () => {
		assert.deepEqual(index.failures.map((f) => f.path), [], 'parse failures');
	});
	// Regression: `stacks['constructor']` once hit Object.prototype.constructor
	// and threw, which silently dropped every file that mentions the word.
	check('a file that says constructor still parses', () => {
		const src = 'export class A { constructor(private x: number) {} run(): number { return this.x; } }\n';
		const fact = extractJsTs('a.ts', src);
		assert.ok(fact.decls.some((d) => d.n === 'A' && d.k === 'class'), JSON.stringify(fact.decls.map((d) => d.n)));
		assert.ok(fact.decls.some((d) => d.n === 'constructor'), 'ctor member missing');
	});

	const found = await query.find({ name: 'parseTimeout' });
	check('find resolves a top-level const', () => {
		assert.equal(found.total, 1);
		assert.equal(found.matches[0].path, 'src/config.ts');
	});
	check('find reports its reference count', () => assert.equal(found.matches[0].refs, 3, `refs=${found.matches[0].refs}`));

	const refs = await query.refs('ts:src/config.ts#parseTimeout');
	check('refs finds call sites in both importers', () => {
		const paths = [...new Set(refs.sites.map((s) => s.path))].sort();
		assert.deepEqual(paths, ['src/policy.ts', 'src/service.ts']);
	});
	check('refs resolves a bare import exactly', () => {
		assert.ok(refs.sites.some((s) => s.path === 'src/policy.ts' && s.confidence === 'exact'));
	});
	check('refs resolves a path-aliased import', () => {
		assert.ok(refs.sites.some((s) => s.path === 'src/service.ts' && s.confidence === 'exact'), JSON.stringify(refs.sites.map((s) => [s.path, s.confidence])));
	});
	check('refs keeps a verifiable line number', () => assert.ok(refs.sites.every((s) => s.line > 0)));

	const policy = await query.hierarchy('ts:src/policy.ts#RetryPolicy');
	check('hierarchy sees extends and implements', () => {
		const kinds = policy.supers.map((s) => s.kind);
		assert.ok(kinds.includes('extends'), kinds.join(','));
		assert.ok(kinds.includes('implements'), kinds.join(','));
	});
	check('hierarchy resolves the extends target', () => assert.ok(policy.supers.some((s) => s.resolved?.id === 'ts:src/config.ts#Base')));

	const base = await query.hierarchy('ts:src/config.ts#Base');
	check('hierarchy finds subtypes by name', () => assert.ok(base.subs.some((s) => s.id === 'ts:src/policy.ts#RetryPolicy'), JSON.stringify(base.subs)));
	check('hierarchy lists own members', () => assert.ok(base.members.some((m) => m.name === 'run')));

	const outline = await query.outline({ pathFilter: 'src/config.ts' });
	check('outline lists declarations', () => {
		const names = outline.items.map((i) => i.name);
		assert.ok(names.includes('Base') && names.includes('Options') && names.includes('parseTimeout'), names.join(','));
	});
	check('outline marks exported vs internal', () => assert.ok(outline.items.some((i) => i.name === 'helper' && i.exported === false)));

	const item = await query.find({ name: 'Item' });
	check('go: find a struct', () => assert.ok(item.matches.some((m) => m.path === 'internal/model/model.go')));
	const itemRefs = await query.refs(item.matches[0].id);
	check('go: resolves a qualified cross-package reference', () => {
		assert.ok(itemRefs.sites.some((s) => s.path === 'internal/store/store.go' && s.confidence === 'exact'), JSON.stringify(itemRefs.sites));
	});
	const repo = await query.hierarchy('go:internal/store/store.go#Repo');
	check('go: struct fields are members', () => assert.ok(repo.members.some((m) => m.name === 'items')));

	const search = await query.search({ text: 'timeout' });
	check('search is substring-based', () => assert.ok(search.total >= 3, `total=${search.total}`));

	// ---- body-only edit -----------------------------------------------------
	const policyPath = path.join(root, 'src/policy.ts');
	const policySrc = await fs.readFile(policyPath, 'utf8');
	await fs.writeFile(
		policyPath,
		policySrc.replace(
			'\t\treturn super.run(input) + wait;',
			'\t\tconst extra = 1;\n\t\treturn super.run(input) + wait + extra;',
		),
		'utf8',
	);
	const bodyEdit = await query.verify({});
	check('body-only edit is not a contract change', () => {
		assert.equal(bodyEdit.summary.contractChanges, 0, JSON.stringify(bodyEdit.summary));
		assert.equal(bodyEdit.summary.bodyOnlyChanges, 1, JSON.stringify(bodyEdit.bodyOnly));
	});
	check('body-only edit reports a clean verdict', () => assert.equal(bodyEdit.verdict, 'internal', bodyEdit.verdict));
	check('body-only edit finds no dangling references', () => assert.equal(bodyEdit.summary.dangling, 0));

	// ---- renamed export -----------------------------------------------------
	const configPath = path.join(root, 'src/config.ts');
	const configSrc = await fs.readFile(configPath, 'utf8');
	await fs.writeFile(configPath, configSrc.replace('parseTimeout', 'parseTimeoutMs'), 'utf8');
	const rename = await query.verify({});
	check('rename reports removed symbol', () => assert.ok(rename.summary.removed >= 1, JSON.stringify(rename.summary)));
	check('rename surfaces dangling references', () => assert.ok(rename.summary.dangling >= 2, JSON.stringify(rename.summary)));
	check('rename verdict is breaking', () => assert.equal(rename.verdict, 'breaking', rename.verdict));
	check('dangling sites carry file and line', () => assert.ok(rename.dangling.every((d) => d.path && d.line > 0)));
	const renamed = await query.find({ name: 'parseTimeoutMs' });
	check('new name is indexed', () => assert.equal(renamed.total, 1));

	// ---- files the manifest never saw ---------------------------------------
	await fs.writeFile(
		path.join(root, 'src/extra.ts'),
		'import { parseTimeoutMs } from "./config";\nexport function readTimeout(): number {\n\treturn parseTimeoutMs;\n}\n',
		'utf8',
	);
	const added = await query.verify({});
	check('a new file is picked up without a full rebuild', () => {
		assert.equal(added.summary.newFiles, 1, JSON.stringify(added.summary));
		assert.ok(added.summary.added >= 1, JSON.stringify(added.summary));
	});
	const foundNew = await query.find({ name: 'readTimeout' });
	check('the new file is queryable afterwards', () => assert.equal(foundNew.total, 1));

	await fs.rm(path.join(root, 'src/extra.ts'));
	const deleted = await query.verify({});
	check('a deleted file reports its symbols as removed', () => {
		assert.equal(deleted.summary.removedFiles, 1, JSON.stringify(deleted.summary));
		assert.ok(deleted.summary.removed >= 1, JSON.stringify(deleted.summary));
	});

	// ---- cache round trip ---------------------------------------------------
	const second = new CodeIndex({ root, cacheDir, log: () => {} });
	const loadStart = Date.now();
	await second.ensure();
	const loadMs = Date.now() - loadStart;
	check('a warm start loads from the manifest', () => assert.equal(second.fileCount, index.fileCount));
	console.log(`\nwarm start: ${loadMs}ms for ${second.fileCount} files`);

	await fs.rm(root, { recursive: true, force: true });

	console.log(`\n${passed} passed, ${failed} failed`);
	if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
