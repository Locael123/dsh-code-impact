/**
 * Go fact extraction.
 *
 * Go is pleasantly regular: declarations start at column 0 in gofmt'd code, so
 * a line scanner plus brace matching gets us a long way. Cross-package
 * references are always qualified (`store.Open`), which makes resolution a
 * straight import-table lookup rather than a scoping problem.
 */

import { hashShort } from './files.js';
import { lineStarts, mask, positionOf } from './lex.js';

const GO_KEYWORDS = new Set([
	'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'for', 'func',
	'go', 'goto', 'if', 'import', 'interface', 'map', 'package', 'range', 'return', 'select', 'struct',
	'switch', 'type', 'var',
]);

const GO_PREDECLARED = new Set([
	'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64', 'int',
	'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32', 'uint64',
	'uintptr', 'append', 'cap', 'clear', 'close', 'complex', 'copy', 'delete', 'imag', 'len', 'make', 'max',
	'min', 'new', 'panic', 'print', 'println', 'real', 'recover', 'true', 'false', 'iota', 'nil',
]);

/** Find the first `{` at paren/bracket depth 0, starting at `from`. */
function findBodyOpen(code, from) {
	let paren = 0;
	let bracket = 0;
	for (let i = from; i < code.length; i += 1) {
		const ch = code[i];
		if (ch === '(') paren += 1;
		else if (ch === ')') paren -= 1;
		else if (ch === '[') bracket += 1;
		else if (ch === ']') bracket -= 1;
		else if (ch === '{' && paren === 0 && bracket === 0) return i;
		else if (ch === ';' && paren === 0 && bracket === 0) return -1;
	}
	return -1;
}

/** Offset of the `}` that closes the `{` at `open`. */
function findBodyClose(code, open) {
	let depth = 0;
	for (let i = open; i < code.length; i += 1) {
		if (code[i] === '{') depth += 1;
		else if (code[i] === '}') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return Math.max(0, code.length - 1);
}

function norm(text) {
	return text.replace(/\s+/g, ' ').trim();
}

function clamp(text, max) {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function splitTopLevel(text, sep = ',') {
	const out = [];
	let depth = 0;
	let cur = '';
	for (const ch of text) {
		if ('([{<'.includes(ch)) depth += 1;
		else if (')]}>'.includes(ch)) depth -= 1;
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

/** Go parameters: `(a, b int, c string)` or `(int, string)`. */
function parseGoParams(text) {
	const inner = text.replace(/^\(/, '').replace(/\)$/, '');
	const params = [];
	for (const chunk of splitTopLevel(inner)) {
		const parts = chunk.replace(/^\.\.\./, '').split(/\s+/);
		if (parts.length >= 2) {
			const type = parts.slice(1).join(' ');
			for (const name of parts[0].split(',').map((s) => s.trim()).filter(Boolean)) {
				params.push({ n: name, t: type, o: false, d: null });
			}
		} else if (parts.length === 1) {
			params.push({ n: '', t: parts[0], o: false, d: null });
		}
	}
	return params;
}

/** Parse the import block / single import lines. */
function parseGoImports(srcLines, noCommentLines) {
	const imports = [];
	const skipLine = new Set();
	for (let i = 0; i < noCommentLines.length; i += 1) {
		const line = noCommentLines[i];
		const single = /^\s*import\s+(?:([\w.]+|_|\.)\s+)?["`]([^"`]+)["`]\s*$/.exec(line);
		if (single) {
			imports.push(makeImport(single[1], single[2], i + 1));
			skipLine.add(i);
			continue;
		}
		if (/^\s*import\s*\(\s*$/.test(line)) {
			skipLine.add(i);
			for (let j = i + 1; j < noCommentLines.length; j += 1) {
				skipLine.add(j);
				const inner = noCommentLines[j];
				if (/^\s*\)/.test(inner)) {
					i = j;
					break;
				}
				const m = /^\s*(?:([\w.]+|_|\.)\s+)?["`]([^"`]+)["`]/.exec(inner);
				if (m) imports.push(makeImport(m[1], m[2], j + 1));
			}
		}
	}
	return { imports, skipLine };
}

function makeImport(alias, spec, line) {
	const last = spec.split('/').filter(Boolean).pop() ?? spec;
	return {
		local: alias && alias !== '_' && alias !== '.' ? alias : last,
		from: spec,
		imported: '*',
		kind: alias === '.' || alias === '_' ? 'side-effect' : 'package',
		line,
	};
}

/**
 * @param {string} path workspace-relative posix path
 * @param {string} src
 */
export function extractGo(path, src) {
	const { noComment, code } = mask(src);
	const starts = lineStarts(src);
	const codeLines = code.split('\n');
	const srcLines = src.split('\n');
	const { imports, skipLine } = parseGoImports(srcLines, noComment.split('\n'));

	/** @type {any[]} */
	const decls = [];
	const declNameAt = new Set(); // "line:col" of declaration names
	const typeIndexByName = new Map();

	const lineFor = (offset) => positionOf(starts, offset).line;
	const snippet = (from, to) => clamp(norm(src.slice(from, to + 1)), 120);

	let i = 0;
	while (i < codeLines.length) {
		const trimmed = codeLines[i].trim();
		if (!trimmed || skipLine.has(i) || /^package\b/.test(trimmed)) {
			i += 1;
			continue;
		}
		const lineStart = starts[i] ?? 0;

		let m;
		// method: func (r *T) Name(...)
		if ((m = /^func\s*\(\s*(?:(\w+)\s+)?\*?\s*([\w.\[\]]+?)\s*\)\s*(\w+)\s*(?:\[[^\]]*\])?\s*\(/.exec(trimmed))) {
			const recvType = m[2].replace(/\[.*$/, '').split('.').pop();
			const open = findBodyOpen(code, lineStart);
			const close = open === -1 ? -1 : findBodyClose(code, open);
			const sigEnd = open === -1 ? lineStart + m[0].length : open;
			const parenOpen = code.indexOf('(', lineStart + trimmed.indexOf(')') + 1);
			const parenClose = parenOpen === -1 ? -1 : matchParen(code, parenOpen);
			const decl = {
				q: '',
				n: m[3],
				k: 'method',
				p: -1,
				l: i + 1,
				el: close === -1 ? i + 1 : lineFor(close),
				x: /^[A-Z]/.test(m[3]) ? 1 : 0,
				sig: snippet(lineStart, sigEnd),
				sh: '',
				bh: open === -1 ? hashShort('decl') : hashShort(code.slice(open, close + 1)),
				h: [],
				params: parenOpen === -1 ? [] : parseGoParams(code.slice(parenOpen, parenClose + 1)),
				recv: recvType,
			};
			decl.sh = hashShort(`${decl.k}|${recvType}.${decl.n}|${decl.sig}`);
			decls.push(decl);
			const col = srcLines[i].indexOf(m[3], srcLines[i].indexOf(')'));
			if (col >= 0) declNameAt.add(`${i}:${col}`);
			i = close === -1 ? i + 1 : lineFor(close);
			continue;
		}
		// function: func Name(...)
		if ((m = /^func\s+(\w+)\s*(?:\[[^\]]*\])?\s*\(/.exec(trimmed))) {
			const open = findBodyOpen(code, lineStart);
			const close = open === -1 ? -1 : findBodyClose(code, open);
			const parenOpen = code.indexOf('(', lineStart);
			const parenClose = parenOpen === -1 ? -1 : matchParen(code, parenOpen);
			const decl = {
				q: m[1],
				n: m[1],
				k: 'function',
				p: -1,
				l: i + 1,
				el: close === -1 ? i + 1 : lineFor(close),
				x: /^[A-Z]/.test(m[1]) ? 1 : 0,
				sig: snippet(lineStart, open === -1 ? lineStart + m[0].length : open),
				sh: '',
				bh: open === -1 ? hashShort('decl') : hashShort(code.slice(open, close + 1)),
				h: [],
				params: parenOpen === -1 ? [] : parseGoParams(code.slice(parenOpen, parenClose + 1)),
			};
			decl.sh = hashShort(`${decl.k}|${decl.n}|${decl.sig}`);
			decls.push(decl);
			const col = srcLines[i].indexOf(m[1], srcLines[i].indexOf('func') + 4);
			if (col >= 0) declNameAt.add(`${i}:${col}`);
			i = close === -1 ? i + 1 : lineFor(close);
			continue;
		}
		// type Name struct|interface
		if ((m = /^type\s+(\w+)\s*(?:\[[^\]]*\])?\s*(?:=\s*)?(struct|interface)\b/.exec(trimmed))) {
			const open = findBodyOpen(code, lineStart);
			const close = open === -1 ? -1 : findBodyClose(code, open);
			const decl = {
				q: m[1],
				n: m[1],
				k: m[2] === 'struct' ? 'struct' : 'interface',
				p: -1,
				l: i + 1,
				el: close === -1 ? i + 1 : lineFor(close),
				x: /^[A-Z]/.test(m[1]) ? 1 : 0,
				sig: `type ${m[1]} ${m[2]}`,
				sh: '',
				bh: open === -1 ? hashShort('decl') : hashShort(code.slice(open, close + 1)),
				h: [],
			};
			decl.sh = hashShort(`${decl.k}|${decl.n}|${decl.sig}`);
			decls.push(decl);
			typeIndexByName.set(m[1], decls.length - 1);
			const col = srcLines[i].indexOf(m[1], srcLines[i].indexOf('type') + 4);
			if (col >= 0) declNameAt.add(`${i}:${col}`);

			if (open !== -1) {
				const openLine = lineFor(open);
				const closeLine = lineFor(close);
				for (let j = openLine; j < closeLine; j += 1) {
					const bodyLine = codeLines[j];
					if (bodyLine === undefined) break;
					const bt = bodyLine.trim();
					if (!bt || bt === '{' || bt === '}') continue;
					if (m[2] === 'interface') {
						const mm = /^(\w+)\s*\(/.exec(bt);
						if (mm) {
							const parenOpen = code.indexOf('(', (starts[j] ?? 0) + bodyLine.indexOf('('));
							const parenClose = parenOpen === -1 ? -1 : matchParen(code, parenOpen);
							decls.push({
								q: `${m[1]}.${mm[1]}`,
								n: mm[1],
								k: 'method',
								p: decls.indexOf(decl),
								l: j + 1,
								el: j + 1,
								x: decl.x,
								sig: clamp(norm(src.slice(starts[j] ?? 0, parenClose === -1 ? (starts[j] ?? 0) + bt.length : parenClose + 1)).replace(m[1], ''), 120),
								sh: '',
								bh: hashShort('abstract'),
								h: [],
								params: parenOpen === -1 ? [] : parseGoParams(src.slice(parenOpen, parenClose + 1)),
							});
						} else {
							const emb = /^\*?([\w.]+)$/.exec(bt);
							if (emb) decl.h.push(['embeds', emb[1].split('.').pop(), j + 1]);
						}
						continue;
					}
					// struct field
					const fm = /^(\w+(?:\s*,\s*\w+)*)\s+([\w.\*\[\]{}]+)/.exec(bt);
					if (fm) {
						const fieldType = fm[2];
						for (const fname of fm[1].split(',').map((s) => s.trim())) {
							decls.push({
								q: `${m[1]}.${fname}`,
								n: fname,
								k: 'field',
								p: decls.indexOf(decl),
								l: j + 1,
								el: j + 1,
								x: /^[A-Z]/.test(fname) ? 1 : 0,
								sig: clamp(`${fname} ${fieldType}`, 120),
								sh: hashShort(`field|${m[1]}.${fname}|${fieldType}`),
								bh: hashShort(`field|${fieldType}`),
								h: [],
								ftype: fieldType,
							});
							const col = srcLines[j].indexOf(fname);
							if (col >= 0) declNameAt.add(`${j}:${col}`);
						}
						continue;
					}
					const emb = /^\*?([\w.]+)$/.exec(bt);
					if (emb) decl.h.push(['embeds', emb[1].split('.').pop(), j + 1]);
				}
				decl.sh = hashShort(`${decl.k}|${decl.n}|${decl.sig}|${decl.h.map((x) => x[1]).join(',')}`);
				i = closeLine;
				continue;
			}
			i += 1;
			continue;
		}
		// other type alias / defined type
		if ((m = /^type\s+(\w+)\s*(?:\[[^\]]*\])?\s*=?\s*(.+)$/.exec(trimmed))) {
			decls.push({
				q: m[1],
				n: m[1],
				k: 'type',
				p: -1,
				l: i + 1,
				el: i + 1,
				x: /^[A-Z]/.test(m[1]) ? 1 : 0,
				sig: clamp(`type ${m[1]} ${norm(m[2])}`, 120),
				sh: hashShort(`type|${m[1]}|${norm(m[2])}`),
				bh: hashShort(`type|${norm(m[2])}`),
				h: [],
			});
			typeIndexByName.set(m[1], decls.length - 1);
			const col = srcLines[i].indexOf(m[1], srcLines[i].indexOf('type') + 4);
			if (col >= 0) declNameAt.add(`${i}:${col}`);
			i += 1;
			continue;
		}
		// const / var, single or block
		const blockStart = /^(const|var)\s*\(\s*$/.exec(trimmed);
		if (blockStart) {
			let j = i + 1;
			for (; j < codeLines.length && !/^\)/.test(codeLines[j].trim()); j += 1) {
				const bt = codeLines[j].trim();
				if (!bt || bt.startsWith('//')) continue;
				const cm = /^(\w+(?:\s*,\s*\w+)*)\s*(?:([\w.\*\[\]{}]+))?\s*(?:=|$)/.exec(bt);
				if (!cm) continue;
				for (const vname of cm[1].split(',').map((s) => s.trim())) {
					decls.push({
						q: vname,
						n: vname,
						k: 'variable',
						p: -1,
						l: j + 1,
						el: j + 1,
						x: /^[A-Z]/.test(vname) ? 1 : 0,
						sig: clamp(bt, 120),
						sh: hashShort(`variable|${vname}|${cm[2] ?? ''}`),
						bh: hashShort(`variable|${bt}`),
						h: [],
					});
					const col = srcLines[j].indexOf(vname);
					if (col >= 0) declNameAt.add(`${j}:${col}`);
				}
			}
			i = j + 1;
			continue;
		}
		const singleDecl = /^(const|var)\s+(\w+)\s*(?:([\w.\*\[\]{}]+))?\s*(?:=\s*(.+))?$/.exec(trimmed);
		if (singleDecl) {
			decls.push({
				q: singleDecl[2],
				n: singleDecl[2],
				k: 'variable',
				p: -1,
				l: i + 1,
				el: i + 1,
				x: /^[A-Z]/.test(singleDecl[2]) ? 1 : 0,
				sig: clamp(trimmed, 120),
				sh: hashShort(`variable|${singleDecl[2]}|${singleDecl[3] ?? ''}`),
				bh: hashShort(`variable|${trimmed}`),
				h: [],
			});
			const col = srcLines[i].indexOf(singleDecl[2], srcLines[i].indexOf(singleDecl[1]) + 3);
			if (col >= 0) declNameAt.add(`${i}:${col}`);
			i += 1;
			continue;
		}
		i += 1;
	}

	// attach methods to their receiver types
	for (const decl of decls) {
		if (decl.k !== 'method' || !decl.recv) continue;
		const ti = typeIndexByName.get(decl.recv);
		if (ti !== undefined) {
			decl.p = ti;
			decl.q = `${decls[ti].q}.${decl.n}`;
		}
	}
	// resolve embed names to declarations when local
	for (const decl of decls) {
		for (const h of decl.h) {
			const ti = typeIndexByName.get(h[1]);
			if (ti !== undefined) h.push(decls[ti].q);
		}
	}

	// ---- refs ----------------------------------------------------------------
	const importsByAlias = new Map(imports.map((im) => [im.local, im]));
	const refs = [];
	const idRe = /[\p{L}_][\p{L}\p{N}_]*/gu;
	let tok;
	while ((tok = idRe.exec(code)) !== null) {
		const name = tok[0];
		const off = tok.index;
		if (GO_KEYWORDS.has(name) || GO_PREDECLARED.has(name)) continue;
		const pos = positionOf(starts, off);
		if (declNameAt.has(`${pos.line - 1}:${pos.col - 1}`)) continue;
		// skip import path contents (masked in code but keep the guard cheap)
		const before = code.slice(Math.max(0, off - 2), off);
		const after = code.slice(off + name.length, off + name.length + 2);
		let role = 'value';
		let via;
		if (before.endsWith('.')) {
			const holderMatch = /([\p{L}_][\p{L}\p{N}_]*)\s*\.$/u.exec(code.slice(Math.max(0, off - 80), off));
			const holder = holderMatch?.[1];
			if (holder && importsByAlias.has(holder)) {
				via = holder;
				role = /^\s*\(/.test(after) ? 'call' : 'type';
			} else {
				continue; // field / method access on a value: not a name edge
			}
		}
		if (via === undefined) {
			if (/^\s*\(/.test(after)) role = 'call';
			else if (/(?:type|interface|struct|\*|\[|\]|map|chan|new)\s*$/.test(code.slice(Math.max(0, off - 12), off))) role = 'type';
			else if (/^[A-Z]/.test(name)) role = 'type';
			else continue; // lowercase value mentions are locals far more often than not
		}
		refs.push({ n: name, r: role, l: pos.line, c: pos.col, o: -1, ...(via === undefined ? {} : { v: via }) });
	}

	const exportsList = decls
		.filter((d) => d.p === -1 && d.x === 1 && (d.k === 'function' || d.k === 'struct' || d.k === 'interface' || d.k === 'type' || d.k === 'variable'))
		.map((d) => ({ exported: d.n, local: d.n, kind: d.k === 'variable' ? 'value' : d.k, line: d.l }));

	return {
		path,
		lang: 'go',
		imports,
		exports: exportsList,
		decls: decls.map((d) => ({
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

function matchParen(code, open) {
	let depth = 0;
	for (let i = open; i < code.length; i += 1) {
		if (code[i] === '(') depth += 1;
		else if (code[i] === ')') {
			depth -= 1;
			if (depth === 0) return i;
		}
	}
	return Math.min(code.length - 1, open);
}
