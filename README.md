# dsh-code-impact

**Post-edit impact checks for [DeepSeek Harness](https://github.com/deepseek-ai) — a symbol index, a reference graph, and an inheritance model that answer "what did this edit touch?" instead of "grep the repo and re-run everything".**

[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square)](package.json)
[![engine](https://img.shields.io/badge/engine-heuristic%20·%20zero%20deps-3DA639?style=flat-square)](#how-it-works)
[![languages](https://img.shields.io/badge/languages-TS%20·%20JS%20·%20Go-3178C6?style=flat-square)](#scope--limits)
[![tests](https://img.shields.io/badge/tests-32%20passing-3DA639?style=flat-square)](test/selftest.mjs)

[中文文档](README.zh.md)

---

## Why

Every small edit — a default value, a rename, a deleted method — triggers the same ceremony:
search the whole repo, open a pile of files, run the full type-check and the full test suite.
The problem isn't wanting full coverage. The problem is doing it by **scanning**.

An index inverts that:

- the whole repo's relationships are already in memory, so a "full check" is one **query**, not a scan;
- after an edit, only the **changed file** is re-parsed, and the reference edges tell you exactly which sites must be revisited;
- answers never say "probably fine" — they give `file:line`, a confidence, and an explicitly listed **unverified** part.

## What you get

Two tools, registered into every agent session.

### `code_query`

| `op` | Answers |
| --- | --- |
| `find` | where is this symbol (`addNode`, `Graph.addNode`, `ts:src/x.ts#Graph.addNode`) |
| `outline` | declaration skeleton of one file, with line ranges, exports, heritage clauses |
| `refs` | who mentions this symbol — each site resolved individually, so a same-named local doesn't count |
| `hierarchy` | extends / implements / subtypes / members (own, inherited, overridden) |
| `search` | substring match over names and signatures |
| `status` | index size, root, cache location, engine mode, parse failures |

```
find "parseTimeout" — 1 match

ts:src/config.ts#parseTimeout
  variable  src/config.ts:1-1  exported  refs:3
  parseTimeout = 30 ;
```

```
refs ts:src/config.ts#parseTimeout — 3 sites (exported, refs:3)
  variable src/config.ts:1  parseTimeout = 30 ;
  confidence: exact 3 · resolved 0 · heuristic 0 · unresolved mentions 0

src/policy.ts:4  value  in RetryPolicy
    timeout = parseTimeout;
src/service.ts:5  value  in makeService
    const policy = buildPolicy({ timeout: parseTimeout });
```

### `code_verify`

Call it after editing instead of re-scanning. It re-parses only the files that changed on disk
(and discovers new ones), then reports a symbol-level diff:

```
verify — verdict: internal
  1 file changed (0 deleted) · +0 -0 symbols · 1 body-only

body-only (signature unchanged, callers unaffected):
  ts:src/config.ts#parseTimeout  refs:6
```

```
verify — verdict: breaking
  1 file changed (0 deleted) · +1 -1 symbols · 1 contract

symbols that no longer exist:
  ts:src/config.ts#parseTimeout

references that no longer resolve:
  dangling src/policy.ts:4  parseTimeout
```

`verdict` has four levels: `clean` (nothing changed), `internal` (implementation only),
`contract` (signature/export changed, callers may need edits), `breaking` (some reference no
longer resolves).

A reference is only called dangling when it **used to resolve to the symbol that went away**. A
mention that never resolved in the first place — `filepath.Base`, a package that is not installed,
a name the heuristic merely guessed at — is not reported, because a false alarm costs more than a
missed one.

The rule that makes it useful in practice: `const timeout = 30` → `= 60` is a **value change**,
reported as body-only, never as a contract change. Containers (class / interface / struct) are not
listed themselves — their members already express the change, so one memo edit doesn't drag the
whole class into the report.

`code_verify` is **incremental**: it reports changes since the index last synced. Ask twice without
editing in between and the second answer is `clean`. That's the intended loop — one question after
each edit, and the answer is about what you just did.

## Install

`dsh-code-impact` is a DSH host bundle: zero dependencies, plain ESM, one patch row.

```bash
# from GitHub (or any published tarball / registry package)
dsh plugin --profile desktop add github:Locael123/dsh-code-impact
dsh web    # restart: the host half of a plugin is imported once, at boot
```

```bash
# from a local checkout
plugin_manager install_bundle <absolute path>/dsh-code-impact
```

Manual install — only if the package is already resolvable from the profile's `node_modules`
(`plugin_manager` does that for you; a bare `cordis.yml` row alone will not):

```yaml
- id: dsh-code-impact
  name: dsh-code-impact
  config:
    maxFiles: 20000
```

The bundle ships its own `cordis.patch.yml`, so the plugin manager path is preferred — it wires the
patch row, links the directory, and keeps `files[]` correct.

| config | default | meaning |
| --- | --- | --- |
| `maxFiles` | `20000` | cap on files per build; truncation is reported in `status` |
| `root` | session working directory | override the indexed root |

Cache: `$DSH_HOME/cache/code-index/<hash(root)>/` — content-addressed `facts/` plus a
`manifest.json`. Editing one file rewrites one fact. It is a **cache**: delete it any time, it
rebuilds; it is never written inside the indexed repo.

## Precision contract

Every answer carries its own bounds instead of a confident guess:

- `confidence: exact | resolved | heuristic | ambiguous` — `exact` resolves to a concrete
  declaration; `heuristic` is unique-name / nearest-path inference;
- `total` / `truncated` — truncation is stated, not hidden;
- `unverified:` — what this particular answer does **not** cover (cross-language edges, dynamic
  references, type-level compatibility).

A file that fails to parse never disappears silently: `code_query op=status` reports
`warning: N file(s) could not be parsed and are NOT indexed`, and `code_verify` states it in
`unverified:`. If the index is under-counting, you get told.

When in doubt it returns candidates rather than "not found".

## Scope & limits

- **Languages**: TypeScript / JavaScript / Go (`.ts .tsx .mts .cts .js .jsx .mjs .cjs .go`).
- **Module resolution**: relative paths with extension and `/index` probing, `tsconfig`/`jsconfig`
  `baseUrl` + `paths`, `go.mod` module prefix with same-package directories.
- **Skipped**: `node_modules` `.git` `dist` `build` `out` `vendor` `target` `__pycache__` `.venv`
  and friends, files over 512 KiB, binaries.
- **Deliberately approximate**: TS `implements` and Go interface satisfaction are structural /
  implicit, so they yield a candidate set marked `heuristic`. This is the only place the tool
  knowingly guesses.
- **Not modelled**: cross-language edges (a Go interface to its implementors, a JSON schema to its
  consumers), dynamic dispatch, generated code.

## How it works

- **Facts, not graphs.** Each file stores only what *this* file says: `imports`, `exports`,
  `decls` (with heritage and members), `refs` (name + position + role + lexical scope). There is no
  target ID on disk. Name → definition is resolved **at query time**, which is why editing one file
  invalidates exactly one file.
- **Stable SymbolId**: `<lang>:<path>#<qualname>`, no line numbers. A rename or move changes the ID,
  and that change is itself the signal.
- **Freshness**: a query `stat`s the files in its answer before returning (`mtime` + `size`), so a
  stale hit is impossible for anything it reports. `code_verify` drives incremental re-indexing;
  external edits are caught by the same stat check; a structural change bumps a manifest version and
  rebuilds.
- **No native modules, no LSP, no subprocess.** A hand-written lexer plus a scope-aware resolver per
  language keeps cold start in the hundreds of milliseconds and the whole plugin dependency-free.

Measured on a 42-file mixed TS/Go workspace: cold build 276 ms, 883 symbols; queries 1–4 ms;
warm start from manifest 3 ms for a 5-file fixture.

## Development

```bash
node test/selftest.mjs
```

The self-test copies `test/fixture` — a deliberately small TS + Go project with a `tsconfig` path
alias, a class hierarchy, and a two-package Go module — into a temp directory, builds a real index,
and runs 32 assertions: body-only edits are not reported as contract changes, a renamed export
surfaces its dangling references, new files are picked up, deleted files are reported, Go
cross-package references resolve `exact`, warm start reloads from the manifest, and a file that
mentions `constructor` still parses.

## License

[MIT](LICENSE)
