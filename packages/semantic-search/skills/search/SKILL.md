# Semantic Codebase Search

Use `search` as your **default exploration tool** for understanding code, finding implementations, and answering questions about the codebase. Use `grep` when you already know the exact text or pattern you're looking for.

## Indexing

The first query builds the index — this may take 10–60 seconds depending on project size. Subsequent queries are fast because the index is incrementally updated (only changed files are re-processed).

## Query Types

The search tool supports three kinds of queries, automatically classified:

- **Identifier queries** — e.g. `AuthMiddleware`, `handleRequest`, `SearchEngine` — finds definitions, usages, and related code for a specific symbol
- **Natural language queries** — e.g. `where is rate limiting handled`, `how does authentication work` — semantic search across code and documentation
- **Path queries** — e.g. `src/auth/`, `packages/ai` — finds code within a directory structure

## Parameters

| Parameter    | Required | Description                                                                 |
| ------------ | -------- | --------------------------------------------------------------------------- |
| `query`      | Yes      | Search query — natural language, identifier, or path                        |
| `projectDir` | Yes      | Absolute path to the project directory. Set this to your current working directory |
| `path`       | No       | Restrict search to files under this subdirectory (relative to project root) |
| `limit`      | No       | Maximum number of results to return (default: 20)                           |
| `rebuild`    | No       | Force a clean index rebuild — use when files have changed significantly     |

## Ranking

Results are ranked using 6 signals fused via **POEM** (Pareto-Optimal Embedded Modeling):

1. **BM25** — keyword matching via FTS5 full-text search
2. **Cosine similarity** — embedding-based semantic similarity (all-MiniLM-L6-v2)
3. **Path match** — query terms appearing in the file path
4. **Symbol match** — query terms matching function/class/type names
5. **Import graph proximity** — files imported by or importing high-scoring files
6. **Git recency** — recently modified files ranked higher

The weight given to each signal varies by query type. Identifier queries emphasize symbol match and BM25; natural language queries emphasize cosine similarity; path queries emphasize path match.

## Results

Each result includes:

- **File path** and **line range** (start–end)
- **Chunk kind** (function, class, method, interface, heading_section, etc.) and **name**
- **Metric scores** for each of the 6 signals
- **Content preview** of the matching code or text

## Tips

- Start broad, then narrow with `path` if you get too many results from different areas
- Use `limit` to get more results when exploring a broad topic (e.g. `limit: 50`)
- Use `rebuild: true` after major refactors, branch switches, or large file changes
- Identifier queries work best for finding where something is defined or used
- Natural language queries work best for understanding how a feature or concept is implemented
- Combine search with `grep` for a powerful workflow: search to find the right files, then grep for exact patterns within them
