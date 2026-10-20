# dsh-code-impact

**给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的改动影响分析插件 —— 符号索引、引用图、继承模型，回答"这次改动影响了什么"，而不是全仓重扫一遍。**

[![DSH plugin](https://img.shields.io/badge/DSH-plugin-4B6BFB?style=flat-square)](package.json)
[![engine](https://img.shields.io/badge/engine-heuristic%20·%20zero%20deps-3DA639?style=flat-square)](#实现要点)
[![languages](https://img.shields.io/badge/languages-TS%20·%20JS%20·%20Go-3178C6?style=flat-square)](#支持范围与边界)
[![tests](https://img.shields.io/badge/tests-32%20passing-3DA639?style=flat-square)](test/selftest.mjs)

[English](README.md)

---

## 它解决什么

小改动也要全量验证，问题不在"全量"这个目标，而在于用**扫描**的方式去做全量。
索引把这件事倒过来：

- 全仓的引用关系平时就在内存里，所以"全量检查"是一次查询，不是一次扫描；
- 改完之后只重解析**改过的文件**，再沿引用边算出必须复核的站点；
- 回答里不带"大概没问题"，而是给出 `file:line`、可信度、以及**明确列出的未验证部分**。

## 两个工具

### `code_query`

| op | 用途 |
| --- | --- |
| `find` | 按名字（`addNode` / `Graph.addNode` / `ts:src/x.ts#Graph.addNode`）定位声明 |
| `outline` | 一个文件的声明骨架（含行号、导出性、继承子句） |
| `refs` | 谁提到了这个符号——逐个解析过滤，同名局部变量不会算进来 |
| `hierarchy` | extends / implements / 子类型 / 成员（含继承与 override） |
| `search` | 名字与签名的子串检索 |
| `status` | 索引规模、根目录、缓存位置、引擎模式、解析失败数 |

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

编辑之后调用，代替重扫。它只重解析**磁盘上有变化的文件**（缺省时顺带发现新建文件），
然后报告符号级差异：

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

`verdict` 四档：`clean`（没有变化）、`internal`（只动了实现）、`contract`（签名/导出变了，
调用方可能要改）、`breaking`（有引用已经解析不到）。

只有**原本确实指向这个符号**的提及，才会在它消失后被判为 dangling。那些一开始就解析不到的
名字——`filepath.Base`、没装的包、启发式只是猜过的名字——不会被报出来：误报的代价比漏报大。

契约判定的一条关键规则：`const timeout = 30` 改成 `= 60` 是**取值变化**，
按 body-only 处理，不会误报成契约变更；类/接口/struct 这类容器本身不计入变更列表
（成员的变化已经表达了它），避免一次小改动就背上整个类。

`code_verify` 是**增量**的：它报的是"自索引上次同步以来"的变化，所以连续调两次而中间
没有编辑，第二次就是 `clean`。要的就是这个语义——每次编辑后问一次，答案就是你刚做的事。

## 安装与配置

`dsh-code-impact` 是一个 DSH host bundle：零依赖、纯 ESM、一行 patch 记录。

```bash
# 从 GitHub 装（或任何已发布的 tarball / registry 包）
dsh plugin --profile desktop add github:yangxy111/dsh-code-impact
dsh web    # 重启：插件的宿主半只在启动时 import 一次
```

```bash
# 从本地 checkout 装
plugin_manager install_bundle <绝对路径>/dsh-code-impact
```

手工安装——只在该包已经能从 profile 的 `node_modules` 解析到时可用（`plugin_manager` 会替你
做好这件事，光加一行 `cordis.yml` 不够）：

```yaml
- id: dsh-code-impact
  name: dsh-code-impact
  config:
    maxFiles: 20000
```

bundle 自带 `cordis.patch.yml`，所以优先用插件管理器——它会写好 patch 记录、链好目录，
并保证 `files[]` 完整。

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `maxFiles` | `20000` | 单次建索引的文件上限，超出会截断并在 `status` 里显示 |
| `root` | 会话工作目录 | 覆盖被索引的根目录 |

缓存位置：`$DSH_HOME/cache/code-index/<hash(root)>/`（内容寻址的 `facts/` + `manifest.json`）。
改一个文件只重写一份 fact。它是**缓存**：随时删，删了自动重建，绝不写进被索引的仓库。

## 精度契约

每条结果都带上下界，而不是一个自信的答案：

- `confidence: exact | resolved | heuristic | ambiguous`——`exact` 是能落到具体声明的证据，
  `heuristic` 是唯一名/就近推断；
- `total` / `truncated`——截断了就说截断了；
- `unverified:`——这一条回答**没有**覆盖什么（跨语言、动态引用、类型级兼容性）。

某个文件解析失败时它不会静默消失：`code_query op=status` 会带上
`warning: N file(s) could not be parsed and are NOT indexed`，`code_verify` 会在
`unverified:` 里声明"有变更文件没有被分析"。索引少算了东西，你必须知道。

宁可给候选，也不说"没有"。

## 支持范围与边界

- 语言：TypeScript / JavaScript / Go（`.ts .tsx .mts .cts .js .jsx .mjs .cjs .go`）。
- 模块解析：相对路径 + 扩展名 + `/index` 探测、`tsconfig`/`jsconfig` 的 `baseUrl` + `paths`、
  `go.mod` 的 module 前缀 + 同包目录。
- 跳过：`node_modules` `.git` `dist` `build` `out` `vendor` `target` `__pycache__` `.venv`
  等目录、超过 512 KiB 的文件、二进制。
- **刻意近似**：TS 的 `implements` 与 Go 的接口满足是结构化/隐式的，只能给候选集并标
  `heuristic`——这是全工具唯一一处明知的猜测。
- **不建模**：跨语言引用（Go interface → 实现者、JSON schema → consumer）、动态派发、生成代码。

## 实现要点

- **只存事实，不存图**：每个文件只记录"本文件说了什么"——`imports`、`exports`、
  `decls`（含 heritage 与成员）、`refs`（名字 + 位置 + 角色 + 词法作用域）。磁盘上没有目标 ID，
  名字→定义是**查询时**解析的，所以编辑一个文件恰好失效一个文件。
- **稳定 SymbolId**：`<lang>:<path>#<qualname>`，不含行号。重命名/移动会改变 ID，而 ID 的变化
  本身就是信号。
- **新鲜度**：返回前对答案里出现的文件做 `stat`（`mtime` + `size`），所以它报出来的东西不会是旧的；
  `code_verify` 驱动增量重建；外部编辑靠同一套 stat 比对；结构性变更靠 manifest 版本戳触发全量重建。
- **没有原生模块、没有 LSP、没有子进程**：手写词法器 + 按语言的作用域解析器，冷启动是几百毫秒，
  整个插件零依赖。

实测（本仓库 42 个 TS/Go 文件）：冷建 276 ms / 883 符号；查询 1–4 ms；5 文件 fixture 的
warm start 3 ms。

## 开发

```bash
node test/selftest.mjs
```

自测在系统临时目录里复制 `test/fixture`（一个刻意造的小 TS + Go 工程，带 `tsconfig` 路径别名、
类继承链、两包 Go module），真实建索引并跑 32 项断言：取值改动不算契约变更、重命名导出后
悬空引用被报出来、新文件被拾取、删除文件被报告、Go 跨包引用为 `exact`、warm start 从 manifest
加载、以及"提到 constructor 的文件依然能解析"这条原型链回归。

## 许可

[MIT](LICENSE)
