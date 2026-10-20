/**
 * Zero-dependency lexical masking.
 *
 * Every downstream extractor works on two length-preserving views of a source
 * file, so an offset found in either view is a valid offset in the original:
 *
 *   noComment - comments replaced by spaces, strings intact
 *   code      - comments AND string bodies replaced by spaces, quotes kept
 *
 * Newlines survive both views, which is what lets line/column survive too.
 * Masking is far cheaper than parsing, and for the syntax facts this index
 * needs (imports, declarations, name mentions) it is also more forgiving of
 * syntax that a hand-written parser would choke on.
 */

const LINE_COMMENT = 1;
const BLOCK_COMMENT = 2;
const STRING = 3;
const TEMPLATE = 4;

/**
 * Blank each range with spaces, preserving length and line breaks.
 * @param {string} src
 * @param {Array<[number, number]>} ranges
 */
function blankRanges(src, ranges) {
	if (ranges.length === 0) return src;
	const parts = [];
	let cur = 0;
	for (const [start, end] of ranges) {
		if (end <= cur) continue;
		const from = Math.max(start, cur);
		parts.push(src.slice(cur, from));
		parts.push(src.slice(from, end).replace(/[^\n]/g, ' '));
		cur = end;
	}
	parts.push(src.slice(cur));
	return parts.join('');
}

/**
 * Walk the source once, collecting the ranges of comments and string literals.
 *
 * Regex literals are deliberately not recognised: telling `/x/` from division
 * needs the parser we are avoiding, and a mis-read only costs a few blank
 * characters, never a wrong symbol.
 *
 * @param {string} src
 * @param {{ templateIsRaw?: boolean }} [options] Go treats backticks as raw strings.
 */
function collect(src, options = {}) {
	const n = src.length;
	const commentRanges = [];
	const stringRanges = [];
	let state = 0;
	let start = 0;
	let i = 0;

	while (i < n) {
		const ch = src[i];
		const next = i + 1 < n ? src[i + 1] : '';

		if (state === 0) {
			if (ch === '/' && next === '/') {
				state = LINE_COMMENT;
				start = i;
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				state = BLOCK_COMMENT;
				start = i;
				i += 2;
				continue;
			}
			if (ch === '"' || ch === "'") {
				state = STRING;
				start = i;
				i += 1;
				continue;
			}
			if (ch === '`') {
				state = options.templateIsRaw ? STRING : TEMPLATE;
				start = i;
				i += 1;
				continue;
			}
			i += 1;
			continue;
		}

		if (state === LINE_COMMENT) {
			if (ch === '\n') {
				commentRanges.push([start, i]);
				state = 0;
			}
			i += 1;
			continue;
		}

		if (state === BLOCK_COMMENT) {
			if (ch === '*' && next === '/') {
				commentRanges.push([start, i + 2]);
				state = 0;
				i += 2;
				continue;
			}
			i += 1;
			continue;
		}

		// string-like states: honour backslash escapes
		if (ch === '\\') {
			i += 2;
			continue;
		}
		if (state === STRING) {
			const closing = options.templateIsRaw ? '`' : src[start];
			if (ch === closing) {
				stringRanges.push([start, i + 1]);
				state = 0;
			}
			i += 1;
			continue;
		}
		// template literal: ends at an unescaped backtick
		if (ch === '`') {
			stringRanges.push([start, i + 1]);
			state = 0;
		}
		i += 1;
	}

	if (state === LINE_COMMENT) commentRanges.push([start, n]);
	if (state === BLOCK_COMMENT) commentRanges.push([start, n]);
	if (state === STRING || state === TEMPLATE) stringRanges.push([start, n]);

	return { commentRanges, stringRanges };
}

/**
 * @param {string} src
 * @param {{ templateIsRaw?: boolean }} [options]
 * @returns {{ noComment: string, code: string }}
 */
export function mask(src, options = {}) {
	const { commentRanges, stringRanges } = collect(src, options);
	return {
		noComment: blankRanges(src, commentRanges),
		code: blankRanges(src, [...commentRanges, ...stringRanges]),
	};
}

/** @param {string} src */
export function lineStarts(src) {
	const starts = [0];
	for (let i = 0; i < src.length; i += 1) {
		if (src.charCodeAt(i) === 10) starts.push(i + 1);
	}
	return starts;
}

/**
 * 1-based line and column for a byte-less (UTF-16) offset.
 * @param {number[]} starts
 * @param {number} offset
 */
export function positionOf(starts, offset) {
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return { line: lo + 1, col: offset - starts[lo] + 1 };
}
