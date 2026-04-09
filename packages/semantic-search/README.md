# @dreb/semantic-search

Semantic codebase search engine with embedding-based ranking and an MCP server. Extracts and indexes code using tree-sitter for AST-aware chunking and a transformer embedding model ([all-MiniLM-L6-v2](https://huggingface.co/Xenova/all-MiniLM-L6-v2)), then ranks results using 6-signal fusion via POEM.

## How Ranking Works

Results are ranked by fusing 6 independent signals using **POEM** (Pareto-Optimal Embedded Modeling) weights that vary per query type:

| Signal              | Description                                                        |
| ------------------- | ------------------------------------------------------------------ |
| **BM25**            | Keyword matching via FTS5 full-text search                         |
| **Cosine similarity** | Embedding-based semantic similarity using all-MiniLM-L6-v2       |
| **Path match**      | Query terms appearing in the file path                             |
| **Symbol match**    | Query terms matching function, class, or type names                |
| **Import graph**    | Proximity to high-scoring files in the import/dependency graph     |
| **Git recency**     | Recently modified files ranked higher                              |

Queries are automatically classified as _identifier_, _natural language_, or _path_ queries, and each type applies different POEM weights to the 6 signals. Identifier queries emphasize symbol match and BM25; natural language queries emphasize cosine similarity; path queries emphasize path match.

POEM constructs a Pareto front over all signal dimensions and assigns ranks based on dominance depth — no manual weight tuning required per signal. See [Pareto-Optimal Embedded Modeling](https://iopscience.iop.org/article/10.1088/2632-2153/ab891b) for the theoretical foundation.

## Requirements

- **Node.js 22+** — uses the built-in `node:sqlite` module (no native dependencies for the database)

## Installation

```bash
npm install @dreb/semantic-search
```

## Usage as Library

```typescript
import { SearchEngine } from "@dreb/semantic-search";

// Create an engine for a project directory
const engine = new SearchEngine("/path/to/project", {
  // All options are optional:
  indexDir: "/path/to/project/.search-index", // default: <projectRoot>/.search-index
  globalMemoryDir: "~/.dreb/memory",          // additional directory to index
  modelCacheDir: "~/.cache/semantic-search/models", // default location for ONNX model
  visibleDirs: (root) => [`${root}/.dreb`],   // extra dirs to scan (bypasses .gitignore)
});

// Search — first call builds the index (10-60s), subsequent calls are fast
const results = await engine.search("where is authentication handled", {
  limit: 20,          // max results (default: 20)
  pathFilter: "src/", // restrict to a subdirectory
  onProgress: (phase, current, total) => {
    console.log(`${phase}: ${current}/${total}`);
  },
});

for (const result of results) {
  console.log(`${result.chunk.filePath}:${result.chunk.startLine}-${result.chunk.endLine}`);
  console.log(`  ${result.chunk.kind} ${result.chunk.name ?? "(anonymous)"}`);
  console.log(`  rank=${result.rank} bm25=${result.scores.bm25} cosine=${result.scores.cosine}`);
}

// Get index statistics
const stats = engine.getStats(); // { files: number, chunks: number } | null

// Force a full re-index (deletes the database, next search rebuilds from scratch)
await engine.resetIndex();

// Check if semantic search is available (node:sqlite present)
SearchEngine.isAvailable();

// Clean up when done
engine.close();
```

### SearchEngineOptions

| Option           | Type                                  | Default                                | Description                                      |
| ---------------- | ------------------------------------- | -------------------------------------- | ------------------------------------------------ |
| `indexDir`       | `string`                              | `<projectRoot>/.search-index`          | Directory for the SQLite index database           |
| `globalMemoryDir`| `string`                              | —                                      | Additional directory to include in the index      |
| `modelCacheDir`  | `string`                              | `~/.cache/semantic-search/models`      | Where the ONNX embedding model is cached          |
| `visibleDirs`    | `(projectRoot: string) => string[]`   | —                                      | Extra directories to scan (bypasses .gitignore)   |

### SearchOptions

| Option       | Type                          | Default | Description                           |
| ------------ | ----------------------------- | ------- | ------------------------------------- |
| `limit`      | `number`                      | `20`    | Maximum number of results to return   |
| `pathFilter` | `string`                      | —       | Restrict to files under this path     |
| `onProgress` | `IndexProgressCallback`       | —       | Progress callback for indexing        |

### API Reference

| Method                | Returns                              | Description                                    |
| --------------------- | ------------------------------------ | ---------------------------------------------- |
| `search(query, opts)` | `Promise<SearchResult[]>`            | Search the codebase (builds/updates index first)|
| `resetIndex()`        | `Promise<void>`                      | Delete the index database; next search rebuilds |
| `close()`             | `void`                               | Dispose engine resources (DB + embedder)        |
| `getStats()`          | `{ files, chunks } \| null`         | Index statistics, or null if not yet opened     |
| `isAvailable()` _(static)_ | `boolean`                       | Whether `node:sqlite` is available              |

## Usage as MCP Server

The package includes an MCP (Model Context Protocol) server that exposes a `search` tool over stdio.

### Standalone

```bash
# Start the server for the current directory
node node_modules/@dreb/semantic-search/bin/server.js

# Or for a specific project
node node_modules/@dreb/semantic-search/bin/server.js /path/to/project
```

### With Claude Code

Register the MCP server directly:

```bash
claude mcp add --transport stdio semantic-search -- node /path/to/node_modules/@dreb/semantic-search/bin/server.js
```

Or use the Claude Code plugin (see below).

## Claude Code Plugin

The package ships with a Claude Code plugin for zero-configuration setup. The plugin registers the MCP server and includes a skill file that teaches Claude Code how to use semantic search effectively.

### Install from npm

```bash
claude plugin install @dreb/semantic-search
```

### Install from local path (development)

```bash
claude --plugin-dir ./packages/semantic-search/claude-code-plugin
```

## Index Location

By default, the index is stored in `.search-index/` at the project root. This directory contains:

- `search.db` — SQLite database with file metadata, chunks, FTS5 index, embeddings, and import graph

Add `.search-index/` to your `.gitignore`.

The location is configurable via the `indexDir` option in the library API. The MCP server always uses the default location.

## What Gets Indexed

- **Code files** — parsed with tree-sitter into AST-aware chunks (functions, classes, methods, interfaces, structs, enums, type aliases, modules). Supported languages: TypeScript, TSX, JavaScript, Python, Go, Rust, Java, C, C++.
- **Text files** — Markdown (by heading sections), YAML/TOML (by top-level keys), JSON, and plaintext (by paragraph).
- **Memory directories** — if configured via `globalMemoryDir` or `visibleDirs`, these are scanned even if they'd normally be excluded by `.gitignore`.

Files matched by `.gitignore` patterns and common non-text directories (`node_modules`, `.git`, `dist`, etc.) are excluded from scanning.

## License

MIT
