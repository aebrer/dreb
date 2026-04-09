# @dreb/semantic-search

Semantic codebase search engine with embedding-based ranking and an MCP server. Extracts and indexes code using tree-sitter for AST-aware chunking and a transformer embedding model ([all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)), then ranks results using 6-signal fusion via POEM.

## Requirements

- **Node.js 22+** — uses the built-in `node:sqlite` module

## Installation

```bash
npm install @dreb/semantic-search
```

## Claude Code Plugin

The package ships as a Claude Code plugin. Install via a marketplace that includes it as an npm source, or register the MCP server directly:

```bash
claude mcp add --transport stdio semantic-search -- npx @dreb/semantic-search semantic-search-mcp
```

For local development:

```bash
claude --plugin-dir /path/to/packages/semantic-search
```

## MCP Server

The package exposes a `search` tool over the Model Context Protocol (stdio transport). The tool accepts:

| Parameter    | Required | Description                                      |
| ------------ | -------- | ------------------------------------------------ |
| `query`      | yes      | Natural language, identifier, or path query       |
| `projectDir` | yes      | Absolute path to the project directory to search  |
| `path`       | no       | Restrict search to files under this path          |
| `limit`      | no       | Maximum results to return (default: 20)           |
| `rebuild`    | no       | Force a clean index rebuild (default: false)      |

Start the server standalone:

```bash
npx @dreb/semantic-search semantic-search-mcp
```

## How Ranking Works

Results are ranked by fusing 6 independent signals using **POEM** (Pareto-Optimal Embedded Modeling) weights that vary per query type:

| Signal                | Description                                                    |
| --------------------- | -------------------------------------------------------------- |
| **BM25**              | Keyword matching via FTS5 full-text search                     |
| **Cosine similarity** | Embedding-based semantic similarity using all-MiniLM-L6-v2    |
| **Path match**        | Query terms appearing in the file path                         |
| **Symbol match**      | Query terms matching function, class, or type names            |
| **Import graph**      | Proximity to high-scoring files in the import/dependency graph |
| **Git recency**       | Recently modified files ranked higher                          |

Queries are automatically classified as _identifier_, _natural language_, or _path_ queries, and each type applies different POEM column weights. POEM constructs a Pareto front over all signal dimensions and assigns ranks based on dominance depth — no manual weight tuning required. See [Pareto-Optimal Embedded Modeling](https://iopscience.iop.org/article/10.1088/2632-2153/ab891b) for the theoretical foundation.

## Library API

```typescript
import { SearchEngine } from "@dreb/semantic-search";

const engine = new SearchEngine("/path/to/project", {
  indexDir: "/custom/index/path",         // default: <projectRoot>/.search-index
  globalMemoryDir: "~/.dreb/memory",      // additional directory to index
  modelCacheDir: "~/.cache/models",       // default: ~/.cache/semantic-search/models
  visibleDirs: (root) => [`${root}/.special`], // extra dirs (bypasses .gitignore)
});

// First call builds the index (10-60s); subsequent calls are fast
const results = await engine.search("where is auth handled", {
  limit: 20,
  pathFilter: "src/",
  onProgress: (phase, current, total) => console.log(`${phase}: ${current}/${total}`),
});

const stats = engine.getStats();    // { files, chunks } | null
await engine.resetIndex();          // delete index, next search rebuilds
await engine.close();               // dispose resources
SearchEngine.isAvailable();         // check for node:sqlite
```

## What Gets Indexed

- **Code** — tree-sitter AST chunks (functions, classes, methods, interfaces, etc.). TypeScript, JavaScript, Python, Go, Rust, Java, C, C++.
- **Text** — Markdown (by heading), YAML/TOML (by key), JSON, plaintext (by paragraph).
- **Extra directories** — via `globalMemoryDir` or `visibleDirs`, scanned even if gitignored.

The index is stored in `.search-index/search.db` at the project root (add `.search-index/` to `.gitignore`).

## License

MIT
