/**
 * Headless smoke test for client.js: it must load through the module loader
 * contract, export apply + inject, and register exactly one settings section.
 * This catches syntax errors and registration shapes without a browser.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await fs.readFile(path.join(here, '..', 'client.js'), 'utf8');

const fakeReact = {
	default: null,
	createElement: (type, props, ...children) => ({ type, props, children }),
	useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
	useEffect: () => {},
	useMemo: (fn) => fn(),
	useCallback: (fn) => fn,
	useRef: (value) => ({ current: value }),
	Fragment: Symbol('fragment'),
};
fakeReact.default = fakeReact;

let loaded = null;
const windowStub = {
	__ModuleLoader__: {
		load: (module) => {
			loaded = module;
		},
	},
	location: { origin: 'http://127.0.0.1:1' },
};

const sandbox = {
	window: windowStub,
	document: {
		documentElement: { classList: { contains: () => false } },
		createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
		head: { appendChild() {} },
		body: { appendChild() {} },
	},
	fetch: async () => ({ ok: false, status: 0, json: async () => ({}) }),
	location: windowStub.location,
	console,
	setTimeout,
	clearTimeout,
	URL,
	URLSearchParams,
	Intl,
	Promise,
	Map,
	Set,
	Math,
	Date,
	JSON,
	Object,
	Array,
	String,
	Number,
	Boolean,
	Error,
	RegExp,
};

vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: 'client.js' });

assert.ok(loaded, 'client.js must call window.__ModuleLoader__.load');
assert.equal(loaded.id, 'dsh-code-impact', 'module id must match the package name');

const exportsObject = loaded.factory((specifier) => {
	if (specifier === 'react') return fakeReact;
	throw new Error(`unexpected require(${JSON.stringify(specifier)})`);
});

assert.equal(typeof exportsObject.apply, 'function', 'client module must export apply');
assert.ok(exportsObject.inject, 'client module must export inject');

const registrations = [];
let ownerKey = null;
const pluginCtx = {
	slots: {
		inject: (owner, factory) => {
			ownerKey = owner;
			factory();
		},
		register: (registration, component) => {
			registrations.push({ registration, component });
			return () => {};
		},
	},
	get: () => undefined,
	systemPrompt: undefined,
	logger: console,
	effect: (fn) => fn(),
};

exportsObject.apply(pluginCtx);

assert.equal(ownerKey, 'settings.section', 'must inject into settings.section');
assert.equal(registrations.length, 1, 'registers exactly one settings section');
const { registration, component } = registrations[0];
assert.equal(registration.name, 'settings.section');
assert.equal(registration.id, 'code-impact');
assert.equal(typeof registration.label, 'function', 'label must follow the locale');
assert.equal(registration.label(), 'Code Impact');
assert.equal(typeof component, 'function', 'the section must render a component');

console.log('client smoke: settings.section registration OK');
