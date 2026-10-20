/**
 * JavaScript / TypeScript fact extraction.
 *
 * This is a lexical extractor, not a parser. It records what a file *says*
 * (declarations, heritage clauses, name mentions with a role and a line) and
 * stops there: which declaration a mention points at is decided later, at query
 * time, by the resolver. That split is what keeps one edit from invalidating
 * the whole index.
 */

import { hashShort } from './files.js';
import { lineStarts, mask, positionOf } from './lex.js';

const DECL_KEYWORDS = new Set(['class', 'interface', 'enum', 'namespace', 'module', 'type', 'function', 'const', 'let', 'var']);
const MODIFIERS = new Set(['export', 'default', 'declare', 'abstract', 'async', 'static', 'public', 'private', 'protected', 'readonly', 'override', 'get', 'set']);

const KEYWORDS = new Set([
	'abstract', 'any', 'as', 'asserts', 'async', 'await', 'bigint', 'boolean', 'break', 'case', 'catch',
	'class', 'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do', 'else', 'enum',
	'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements',
	'import', 'in', 'infer', 'instanceof', 'interface', 'is', 'keyof', 'let', 'module', 'namespace',
	'never', 'new', 'null', 'number', 'object', 'of', 'override', 'private', 'protected', 'public',
	'readonly', 'return', 'satisfies', 'set', 'static', 'string', 'super', 'switch', 'symbol', 'this',
	'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unique', 'unknown', 'var', 'void', 'while',
	'with', 'yield',
]);

const ROLE_JSX_BEFORE = new Set(['<', '</']);
const STATEMENT_START = new Set([';', '{', '}', '(', ')', ',']);

/**
 * Tokenize the string-and-comment-masked source.
 * @param {string} code
 */
function tokenize(code) {
	/** @type {{ t: string, i: number, afterDot: boolean }[]} */
	const tokens = [];
	const re = /[A-Za-z_$#][\w$]*|\d[\w.]*|[^\s]/g;
	let m;
	let prevEnd = -1;
	let prevText = '';
	while ((m = re.exec(code)) !== null) {
		let t = m[0];
		const i = m.index;
		// glue `=>` and `...` and `?.` so call/arrow detection stays simple
		if (t === '=' && code[i + 1] === '>') {
			t = '=>';
			re.lastIndex = i + 2;
		} else if (t === '.' && code[i + 1] === '.' && code[i + 2] === '.') {
			t = '...';
			re.lastIndex = i + 3;
		}
		const afterDot = prevText === '.' && prevEnd === i;
		tokens.push({ t, i, afterDot });
		prevText = t;
		prevEnd = i + t.length;
	}
	return tokens;
}

/** Pair up `{()}`-family delimiters; returns open→close index maps. */
function matchDelims(tokens) {
	const pairs = { '{': '}', '(': ')', '[': ']' };
	const maps = new Map([['{', new Map()], ['(', new Map()], ['[', new Map()]]);
	const closes = new Map([['}', '{'], [')', '('], [']', '[']]);
	const stacks = new Map([['{', []], ['(', []], ['[', []]]);
	for (let i = 0; i < tokens.length; i += 1) {
		const t = tokens[i].t;
		// A Map, not an object: `stacks['constructor']` on a plain object is
		// Object.prototype.constructor, and the file that says `constructor`
		// is exactly the kind of file a class parser sees.
		if (stacks.has(t)) {
			stacks.get(t).push(i);
			continue;
		}
		const opener = closes.get(t);
		if (opener === undefined) continue;
		const stack = stacks.get(opener);
		const open = stack.pop();
		if (open === undefined) continue;
		maps.get(opener).set(open, i);
		maps.get(opener).set(i, open);
	}
	return maps;
}

function norm(text) {
	return text.replace(/\s+/g, ' ').trim();
}

function clamp(text, max) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Build a human-checkable signature from a token slice. */
function signatureOf(tokens, from, to) {
	const parts = [];
	for (let i = from; i <= to && i < tokens.length; i += 1) parts.push(tokens[i].t);
	return clamp(norm(parts.join(' ')).replace(/ ?([:,.()<>[\]{}]) ?/g, '$1'), 120);
}

/** Split comma-separated top-level parameter text. */
function splitTopLevel(text, sep = ',') {
	const out = [];
	let depth = 0;
	let cur = '';
	for (const ch of text) {
		if ('<([{'.includes(ch)) depth += 1;
		else if ('>)]}'.includes(ch)) depth -= 1;
		if (ch === sep && depth <= 0) {
			out.push(cur);
			cur = '';
			continue;
		}
		cur += ch;
	}
	if (cur.trim()) out.push(cur);
	return out.map((s) => s.trim()).filter(Boolean);
}

/** Parse `(a: T, b?) => R` parameter text into bindings. */
function parseParams(text) {
	const list = splitTopLevel(text.replace(/^\(|\)$/g, ''));
	const params = [];
	for (const raw of list) {
		const chunk = raw.replace(/^(public|private|protected|readonly)\s+/, '');
		if (chunk === '...rest' || chunk.startsWith('...')) {
			const name = chunk.slice(3).split(/[:=]/)[0].trim();
			if (name) params.push({ n: name, t: '', o: true, d: null });
			continue;
		}
		const eq = chunk.indexOf('=');
		const head = eq === -1 ? chunk : chunk.slice(0, eq);
		const def = eq === -1 ? null : chunk.slice(eq + 1).trim();
		const colon = head.indexOf(':');
		const name = (colon === -1 ? head : head.slice(0, colon)).replace(/\?$/, '').trim();
		if (name) params.push({ n: name, t: colon === -1 ? '' : head.slice(colon + 1).trim(), o: head.includes('?'), d: def });
	}
	return params;
}

/**
 * Parse import / export-from statements.
 * Returns bindings, re-exports, and the token ranges to ignore when scanning refs.
 */
function parseModuleEdges(noComment, lineStarts) {
	const imports = [];
	const reexports = [];
	const skipRanges = [];
	const starImports = [];

	const SPEC = `(['"])([^'"\\n]+)\\1`;
	const importRe = new RegExp(`\\bimport\\s+(type\\s+)?([^;'"\\n]*?)\\s*from\\s*${SPEC}|\\bimport\\s+(type\\s+)?${SPEC}|\\bimport\\s*${SPEC}`, 'g');
	let m;
	while ((m = importRe.exec(noComment)) !== null) {
		const start = m.index;
		const end = m.index + m[0].length;
		if (m[2] !== undefined && m[3] !== undefined) {
			const isType = Boolean(m[1] || m[4]);
			const spec = m[4];
			const clause = m[2].trim();
			const pos = positionOf(lineStarts, start);
			const bindings = parseImportClause(clause, spec, pos.line, isType, starImports);
			imports.push(...bindings);
			skipRanges.push([start, end]);
		} else if (m[5] !== undefined) {
			imports.push({ local: '', from: m[5], imported: '*side-effect*', kind: 'side-effect', line: positionOf(lineStarts, start).line });
			skipRanges.push([start, end]);
		}
	}

	const reexportRe = new RegExp(`\\bexport\\s+(type\\s+)?(\\*|\\{[^}]*\\})\\s*from\\s*${SPEC}`, 'g');
	while ((m = reexportRe.exec(noComment)) !== null) {
		const spec = m[4];
		const line = positionOf(lineStarts, m.index).line;
		if (m[2] === '*') {
			reexports.push({ exported: '*', from: spec, imported: '*', kind: 'star', line });
		} else {
			for (const part of splitTopLevel(m[2].replace(/[{}]/g, ''))) {
				const [a, b] = part.split(/\s+as\s+/);
				reexports.push({ exported: (b ?? a).trim(), from: spec, imported: a.trim(), kind: m[1] ? 'type' : 'value', line });
			}
		}
		skipRanges.push([m.index, m.index + m[0].length]);
	}

	// `export { a, b as c }` without a source: local renames
	const exportClauseRe = /\bexport\s+(type\s+)?\{([^}]*)\}(?!\s*from)/g;
	while ((m = exportClauseRe.exec(noComment)) !== null) {
		const line = positionOf(lineStarts, m.index).line;
		for (const part of splitTopLevel(m[2])) {
			const [a, b] = part.split(/\s+as\s+/);
			reexports.push({ exported: (b ?? a).trim(), from: '', imported: a.trim(), kind: m[1] ? 'type' : 'value', line });
		}
		skipRanges.push([m.index, m.index + m[0].length]);
	}

	return { imports, reexports, skipRanges, starImports };
}

function parseImportClause(clause, spec, line, isType, starImports) {
	const out = [];
	if (!clause) return out;
	let rest = clause.trim();
	if (rest.startsWith('type ')) rest = rest.slice(5).trim();
	const ns = rest.match(/^\*\s+as\s+([\w$]+)$/);
	if (ns) {
		out.push({ local: ns[1], from: spec, imported: '*', kind: 'namespace', line });
		starImports.push(ns[1]);
		return out;
	}
	const braceMatch = rest.match(/^(.*?)\{([^}]*)\}\s*$/);
	if (braceMatch) {
		const def = braceMatch[1].replace(/,\s*$/, '').trim();
		if (def) out.push({ local: def, from: spec, imported: 'default', kind: isType ? 'type' : 'default', line });
		for (const part of splitTopLevel(braceMatch[2])) {
			if (!part) continue;
			const [a, b] = part.split(/\s+as\s+/);
			out.push({ local: (b ?? a).trim(), from: spec, imported: a.trim(), kind: isType ? 'type' : 'value', line });
		}
		return out;
	}
	const defOnly = rest.match(/^([\w$]+)$/);
	if (defOnly) out.push({ local: defOnly[1], from: spec, imported: 'default', kind: isType ? 'type' : 'default', line });
	return out;
}

/**
 * @param {string} path workspace-relative, posix separators
 * @param {string} src
 */
export function extractJsTs(path, src) {
	const { noComment, code } = mask(src);
	const starts = lineStarts(src);
	const tokens = tokenize(code);
	const delims = matchDelims(tokens);
	const braces = delims.get('{');
	const parens = delims.get('(');

	const { imports, reexports, skipRanges } = parseModuleEdges(noComment, starts);

	/** @type {any[]} */
	const decls = [];
	const declNameTok = new Set();

	// ---- pass 1: declaration sites -------------------------------------------
	for (let ti = 0; ti < tokens.length; ti += 1) {
		const tok = tokens[ti];
		if (!DECL_KEYWORDS.has(tok.t) || tok.afterDot) continue;
		// `type` only declares when followed by name and then `=` or `<`
		let ni = ti + 1;
		if (tokens[ni]?.t === '*') ni += 1;
		const nameTok = tokens[ni];
		if (!nameTok || !/^[A-Za-z_$][\w$]*$/.test(nameTok.t) || KEYWORDS.has(nameTok.t)) continue;
		if (tok.t === 'type') {
			const after = tokens[ni + 1]?.t;
			if (after !== '=' && after !== '<') continue;
		}
		if (tok.t === 'function' && tokens[ti + 1]?.t === '*') ni += 1;

		// export / default detection: look back through modifiers
		let exported = false;
		let isDefault = false;
		for (let k = ti - 1, steps = 0; k >= 0 && steps < 5; k -= 1, steps += 1) {
			const t = tokens[k].t;
			if (t === 'export') {
				exported = true;
				break;
			}
			if (t === 'default') {
				isDefault = true;
				continue;
			}
			if (!MODIFIERS.has(t)) break;
		}
		if (tokens[ti + 1]?.t === 'default') exported = true;

		let kind = tok.t;
		if (kind === 'let' || kind === 'var') kind = 'variable';
		if (kind === 'const') {
			// an arrow function or function expression counts as a function
			const eq = findToken(tokens, ni, '=');
			if (eq !== -1 && (tokens[eq + 1]?.t === 'async' || tokens[eq + 1]?.t === '(' || tokens[eq + 2]?.t === '=>')) kind = 'function';
			else kind = 'variable';
		}

		const decl = {
			q: nameTok.t,
			n: nameTok.t,
			k: kind,
			p: -1,
			l: positionOf(starts, tok.i).line,
			el: positionOf(starts, tok.i).line,
			x: exported ? 1 : 0,
			sig: '',
			sh: '',
			bh: '',
			h: [],
			_ti: ti,
			_ni: ni,
			_def: isDefault,
		};
		decls.push(decl);
		declNameTok.add(ni);
	}

	// ---- pass 2: bodies, nesting, signatures ---------------------------------
	const order = decls.map((d, index) => index).sort((a, b) => decls[a]._ti - decls[b]._ti);
	const containStack = [];
	for (const index of order) {
		const decl = decls[index];
		const ti = decl._ti;
		const ni = decl._ni;
		const open = findBodyBrace(tokens, braces, ni);
		if (open !== -1) {
			const close = braces.get(open) ?? open;
			decl.el = positionOf(starts, tokens[close].i).line;
			decl._b0 = open;
			decl._b1 = close;
			decl.bh = hashShort(tokens.slice(open, close + 1).map((t) => t.t).join(' '));
		} else {
			decl.bh = hashShort('empty');
			decl._b0 = -1;
			decl._b1 = -1;
			decl._s1 = statementEnd(tokens, braces, ni, tokens.length - 1);
		}
		// nest inside the innermost enclosing container that accepts members
		while (containStack.length > 0) {
			const top = containStack[containStack.length - 1];
			if (top._b0 !== -1 && top._b0 < ti && ti < top._b1) break;
			containStack.pop();
		}
		const parent = containStack[containStack.length - 1];
		if (parent !== undefined && ['class', 'interface', 'namespace', 'module', 'enum'].includes(parent.k)) {
			decl.p = decls.indexOf(parent);
			decl.q = `${parent.q}.${decl.n}`;
		}
		containStack.push(decl);

		decl.sig = buildSignature(tokens, delims, decl);
		decl.sh = hashShort(`${decl.k}|${decl.q}|${decl.sig}`);
	}

	// heritage clauses (`extends` / `implements`) stay as names; they are matched
	// to declarations at query time so an edit here cannot stale another file.
	for (const decl of decls) {
		if (decl.k !== 'class' && decl.k !== 'interface') continue;
		const line = decl.l;
		const end = decl._b0 === -1 ? Math.min(decl._ni + 60, tokens.length) : decl._b0;
		let mode = null;
		let angle = 0;
		for (let ti = decl._ni + 1; ti < end; ti += 1) {
			const t = tokens[ti].t;
			if (t === 'extends') {
				mode = 'extends';
				continue;
			}
			if (t === 'implements') {
				mode = 'implements';
				continue;
			}
			if (t === '<') {
				angle += 1;
				continue;
			}
			if (t === '>') {
				angle -= 1;
				continue;
			}
			if (angle > 0) continue;
			if (t === ',' || t === '?' || t === '(' || t === ')' || t === '=') continue;
			if (mode === null) break;
			if (/^[A-Za-z_$][\w$]*$/.test(t) && !KEYWORDS.has(t)) {
				const prev = decl.h[decl.h.length - 1];
				if (prev && tokens[ti - 1]?.t === '.') prev[1] = `${prev[1]}.${t}`;
				else decl.h.push([mode, t, line]);
				continue;
			}
			break;
		}
	}

	// ---- members -------------------------------------------------------------
	const memberDecls = [];
	const memberBodyRanges = [];
	for (const decl of decls) {
		if (!['class', 'interface'].includes(decl.k) || decl._b0 === -1) continue;
		const bodyOpen = decl._b0;
		const bodyClose = decl._b1;
		let depth = 0;
		for (let ti = bodyOpen + 1; ti < bodyClose; ti += 1) {
			const t = tokens[ti].t;
			if (t === '{') {
				depth += 1;
				const close = braces.get(ti);
				if (depth === 1 && close !== undefined) {
					ti = close; // a nested block that is not a member body
					depth = 0;
					continue;
				}
				continue;
			}
			if (t === '}') {
				depth -= 1;
				continue;
			}
			if (depth !== 0) continue;
			if (!/^[A-Za-z_$#][\w$]*$/.test(t)) continue;
			if (KEYWORDS.has(t) && !['constructor', 'get', 'set', 'static', 'async'].includes(t)) continue;
			const nextTok = tokens[ti + 1];
			if (!nextTok) break;
			if (!['(', ':', '=', '?', ';', '<'].includes(nextTok.t)) continue;
			// skip labels like `case x:` at this depth - classes rarely have them
			const memberKind = t === 'constructor' ? 'ctor' : nextTok.t === '(' ? 'method' : 'field';
			if (decl.k === 'interface' && memberKind === 'method' && nextTok.t !== '(') continue;
			// modifiers immediately before
			const mods = [];
			for (let k = ti - 1; k > bodyOpen && mods.length < 4; k -= 1) {
				const mt = tokens[k].t;
				if (MODIFIERS.has(mt)) mods.push(mt);
				else break;
			}
			let sigFrom = ti;
			if (mods.length > 0) sigFrom = ti - mods.length;
			const pOpen = nextTok.t === '(' ? ti + 1 : -1;
			const pClose = pOpen === -1 ? -1 : parens.get(pOpen) ?? pOpen;
			const member = {
				q: `${decl.q}.${t}`,
				n: t,
				k: memberKind,
				p: decls.indexOf(decl),
				l: positionOf(starts, tokens[ti].i).line,
				el: positionOf(starts, tokens[ti].i).line,
				x: decl.x && !mods.includes('private') && !mods.includes('protected'),
				sig: '',
				sh: '',
				bh: '',
				h: [],
				params: pOpen === -1 ? [] : parseParams(sliceTokens(tokens, pOpen, pClose)),
			};
			if (memberKind === 'method' || memberKind === 'ctor') {
				const mOpen = findBodyBrace(tokens, braces, pClose === -1 ? ti : pClose);
				const mClose = mOpen === -1 ? -1 : braces.get(mOpen) ?? mOpen;
				member.bh = mClose === -1 ? hashShort('abstract') : hashShort(tokens.slice(mOpen, mClose + 1).map((x) => x.t).join(' '));
				if (mClose !== -1) member.el = positionOf(starts, tokens[mClose].i).line;
				member.sig = signatureOf(tokens, sigFrom, pClose === -1 ? nextTok.i === undefined ? ti : ti : pClose);
				// include return type up to the body brace
				if (mOpen !== -1 && mOpen > pClose) member.sig = clamp(`${member.sig}${norm(sliceTokens(tokens, pClose + 1, mOpen - 1).replace(/[{]/g, ''))}`.replace(/\s+/g, ' '), 120);
			} else {
				const end = statementEnd(tokens, braces, ti, bodyClose);
				member.sig = clamp(signatureOf(tokens, sigFrom, end), 120);
				member.bh = hashShort(tokens.slice(ti, end + 1).map((x) => x.t).join(' '));
				// skip the initializer so `timeout = parseTimeout` does not also
				// register `parseTimeout` as a field
				if (end > ti) ti = end;
			}
			member.sh = hashShort(`${member.k}|${member.q}|${member.sig}`);
			memberDecls.push(member);
			if (memberKind === 'method' || memberKind === 'ctor') {
				const mOpen = findBodyBrace(tokens, braces, pClose === -1 ? ti : pClose);
				if (mOpen !== -1) {
					memberBodyRanges.push([mOpen, braces.get(mOpen) ?? mOpen]);
					ti = braces.get(mOpen) ?? mOpen;
				}
			}
		}
	}

	// Locals are not API. A `const` inside a function body is an implementation
	// detail, and counting it as a declaration would make every edit look like it
	// changed the surface. Runs after the member pass so method bodies count too.
	const containerKinds = ['class', 'interface', 'namespace', 'module', 'enum'];
	const fnRanges = [];
	for (const decl of decls) {
		if (decl._b0 === -1 || containerKinds.includes(decl.k)) continue;
		fnRanges.push([decl._b0, decl._b1]);
	}
	for (const range of memberBodyRanges) fnRanges.push(range);
	if (fnRanges.length > 0) {
		const before = decls.slice();
		const kept = decls.filter((decl) => !fnRanges.some(([a, z]) => a < decl._ti && decl._ti < z));
		if (kept.length !== before.length) {
			const position = new Map(kept.map((decl, index) => [decl, index]));
			const remap = (holder) => {
				const old = before[holder.p];
				holder.p = old ? position.get(old) ?? -1 : -1;
			};
			for (const decl of kept) remap(decl);
			for (const member of memberDecls) remap(member);
			decls.length = 0;
			decls.push(...kept);
		}
	}

	const allDecls = [...decls, ...memberDecls];
	const ownerRanges = allDecls.filter((d) => d._b0 !== undefined && d._b0 !== -1).sort((a, b) => a._b0 - b._b0);

	// ---- exports -------------------------------------------------------------
	const exportsList = [];
	for (const d of decls) {
		if (!d.x) continue;
		const kind = d.k === 'interface' || d.k === 'type' ? 'type' : 'value';
		exportsList.push({ exported: d.n, local: d.n, kind, line: d.l });
		if (d._def) exportsList.push({ exported: 'default', local: d.n, kind: 'default', line: d.l });
	}
	for (const r of reexports) exportsList.push({ exported: r.exported, local: r.imported, from: r.from, kind: r.kind === 'type' ? 'type' : 'value', star: r.kind === 'star', line: r.line });

	// ---- refs ----------------------------------------------------------------
	const skipTok = new Set();
	for (const [s, e] of skipRanges) {
		for (let i = 0; i < tokens.length; i += 1) {
			if (tokens[i].i >= s && tokens[i].i < e) skipTok.add(i);
			if (tokens[i].i >= e) break;
		}
	}
	const importLocals = new Set(imports.map((im) => im.local).filter(Boolean));
	const refs = [];
	let ownerStack = [];
	for (let ti = 0; ti < tokens.length; ti += 1) {
		const tok = tokens[ti];
		const name = tok.t;
		if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
		if (KEYWORDS.has(name) || skipTok.has(ti) || declNameTok.has(ti)) continue;

		const pos = positionOf(starts, tok.i);
		// maintain enclosing-declaration stack for the owner field
		while (ownerStack.length > 0 && !(ownerStack[ownerStack.length - 1]._b0 <= ti && ti <= ownerStack[ownerStack.length - 1]._b1)) ownerStack.pop();
		const ownerDecl = ownerStack[ownerStack.length - 1];
		while (ownerRanges.length > 0 && ownerRanges[0]._b0 <= ti) {
			const candidate = ownerRanges.shift();
			if (candidate._b1 >= ti) {
				ownerStack.push(candidate);
				break;
			}
		}

		const prev = tokens[ti - 1]?.t;
		const next = tokens[ti + 1]?.t;
		let via;
		if (prev === '.') {
			// `ns.Member`: record only when `ns` is a namespace/default import
			const holder = tokens[ti - 2]?.t;
			if (holder === undefined || !importLocals.has(holder)) continue;
			via = holder;
		}
		// object literal key / type property name: `{ key: ... }`
		if (next === ':' && (prev === '{' || prev === ',' || prev === ';' || prev === undefined)) continue;

		let role = 'value';
		if (prev === 'new') role = 'new';
		else if (prev === 'extends') role = 'extends';
		else if (prev === 'implements') role = 'implements';
		else if (prev === '<' && (tokens[ti - 1].i + 1 === tok.i)) role = next === '>' || next === '/' || next === ',' || next === '=' ? 'jsx' : 'type';
		else if (next === '(') role = 'call';
		else if (prev === ':') role = 'type';
		else if (prev === '|' || prev === '&') role = 'type';
		else if (prev === 'as' || prev === 'satisfies' || prev === 'typeof' || prev === 'keyof') role = 'type';
		else if (via !== undefined) role = next === '(' ? 'call' : 'member';

		refs.push({ n: name, r: role, l: pos.line, c: pos.col, o: ownerDecl === undefined ? -1 : allDecls.indexOf(ownerDecl), ...(via === undefined ? {} : { v: via }) });
	}

	return {
		path,
		lang: path.endsWith('.go') ? 'go' : 'ts',
		imports,
		exports: exportsList.filter((e, i, arr) => arr.findIndex((x) => x.exported === e.exported) === i),
		decls: allDecls.map((d) => ({
			q: d.q,
			n: d.n,
			k: d.k,
			p: d.p,
			l: d.l,
			el: d.el,
			x: d.x,
			sig: d.sig,
			sh: d.sh,
			bh: d.bh,
			h: d.h,
			...(d.params ? { params: d.params } : {}),
		})),
		refs,
	};
}

function sliceTokens(tokens, from, to) {
	if (from < 0 || to < 0 || to < from) return '';
	const parts = [];
	for (let i = from; i <= to && i < tokens.length; i += 1) parts.push(tokens[i].t);
	return parts.join(' ');
}

function findToken(tokens, from, needle, limit = 60) {
	for (let i = from; i < Math.min(tokens.length, from + limit); i += 1) if (tokens[i].t === needle) return i;
	return -1;
}

function findBodyBrace(tokens, braces, from) {
	for (let i = from; i < tokens.length && i < from + 400; i += 1) {
		if (tokens[i].t === '{') return i;
		if (tokens[i].t === ';') return -1;
	}
	return -1;
}

function statementEnd(tokens, braces, from, limit) {
	for (let i = from; i < limit && i < tokens.length; i += 1) {
		if (tokens[i].t === ';') return i;
		if (tokens[i].t === '{') {
			const close = braces.get(i);
			return close ?? i;
		}
	}
	return Math.min(from + 20, limit);
}

function buildSignature(tokens, delims, decl) {
	const parens = delims.get('(');
	const startTi = decl._ni;
	if (decl.k === 'function') {
		const open = findToken(tokens, startTi, '(');
		if (open === -1) return decl.n;
		const close = parens.get(open) ?? open;
		const ret = decl._b0 !== -1 && decl._b0 > close ? norm(sliceTokens(tokens, close + 1, decl._b0 - 1)).replace(/^\s*:\s*/, '') : '';
		return clamp(norm(`${decl.n}${sliceTokens(tokens, open, close)}${ret ? `: ${ret}` : ''}`), 120);
	}
	if (decl.k === 'class' || decl.k === 'interface') {
		const parts = [decl.n];
		for (const [kind, name] of decl.h ?? []) parts.push(`${kind} ${name}`);
		if (decl.k === 'class') {
			const b0 = decl._b0 ?? -1;
			if (b0 !== -1) {
				const head = norm(sliceTokens(tokens, decl._ni + 1, b0 - 1));
				return clamp(`${decl.n} ${head}`.replace(/\s+/g, ' '), 120);
			}
		}
		return clamp(parts.join(' '), 120);
	}
	if (decl.k === 'namespace' || decl.k === 'module' || decl.k === 'enum') return decl.n;
	// type alias / const: show the annotation or the initializer
	const end = decl._b0 !== -1 ? decl._b0 : decl._s1 !== undefined && decl._s1 >= decl._ni ? decl._s1 : Math.min(decl._ni + 24, tokens.length - 1);
	return clamp(norm(sliceTokens(tokens, decl._ni, end)).replace(/\s+/g, ' '), 120);
}
