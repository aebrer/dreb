# Spec: Web Tools (web_search + web_fetch)

## Overview

Two tools for web access: `web_search` queries a search engine and returns structured results, `web_fetch` retrieves a URL and returns extracted text content. Together they form the research workflow (search → pick URLs → fetch details).

## web_search

### Tool definition

```
Name: web_search
Description: Search the web for information. Returns structured results
             with titles, URLs, and snippets.

Parameters:
  query:    string (required)  # The search query
```

### Behavior

```
Pseudocode:

function web_search(query):
    # Call configured search backend
    raw_results = search_backend.query(query)

    # Normalize to common format
    results = []
    for r in raw_results:
        results.append({
            "title": r.title,
            "url": r.url,
            "snippet": r.snippet or r.description,
        })

    # Cap results
    results = results[:10]

    return {
        "query": query,
        "results": results,
        "result_count": len(results),
    }
```

### Search backend abstraction

The search backend is configurable. Dreb ships with adapters for:

1. **SearXNG** (default/recommended) — self-hosted metasearch engine, no API key needed
   - Config: `search.backend = "searxng"`, `search.searxng_url = "http://localhost:8888"`
   - Query: `GET {searxng_url}/search?q={query}&format=json`

2. **Brave Search API** — commercial, requires API key
   - Config: `search.backend = "brave"`, `search.brave_api_key = "..."`
   - Query: `GET https://api.search.brave.com/res/v1/web/search?q={query}`
   - Header: `X-Subscription-Token: {api_key}`

3. **DuckDuckGo HTML** — no API key, scrape-based fallback
   - Config: `search.backend = "ddg"`
   - Query: `GET https://html.duckduckgo.com/html/?q={query}`
   - Parse: extract result titles, URLs, snippets from HTML response

Backend selection lives in dreb config (`~/.dreb/config.json` or `.dreb/config.json`):
```json
{
  "search": {
    "backend": "searxng",
    "searxng_url": "http://localhost:8888"
  }
}
```

### Error handling

- Search backend unreachable → return error message, don't crash
- Empty results → return `{"query": query, "results": [], "result_count": 0}`
- Rate limiting → return error with retry hint

## web_fetch

### Tool definition

```
Name: web_fetch
Description: Fetch a URL and return its text content. Extracts readable text
             from HTML pages. Use for reading documentation, articles, or any
             web page content.

Parameters:
  url:    string (required)  # The URL to fetch
```

### Behavior

```
Pseudocode:

function web_fetch(url):
    # Validate URL
    if not is_valid_url(url):
        return error("Invalid URL")

    # Check cache (15-minute TTL)
    cached = cache.get(url)
    if cached and cached.age < 900_000:  # 15 min in ms
        return cached.content

    # Fetch with HTTP client
    response = http_get(url, {
        timeout: 30_000,
        follow_redirects: true,  # same-host only
        max_redirects: 5,
        headers: {
            "User-Agent": "dreb/1.0 (web fetch tool)",
            "Accept": "text/html,application/xhtml+xml,text/plain,application/pdf",
        }
    })

    if response.status != 200:
        return error(f"HTTP {response.status}: {response.status_text}")

    content_type = response.headers["content-type"]

    if "text/html" in content_type:
        # Extract readable text from HTML
        text = html_to_text(response.body)
    elif "text/plain" in content_type:
        text = response.body
    elif "application/pdf" in content_type:
        text = extract_pdf_text(response.body)
    else:
        return error(f"Unsupported content type: {content_type}")

    # Truncate to prevent context overflow
    if len(text) > 100_000:  # ~100KB
        text = text[:100_000] + "\n\n[Content truncated at 100KB]"

    result = {
        "url": url,
        "title": extract_title(response.body) if "html" in content_type else url,
        "content": text,
        "content_length": len(text),
        "fetched_at": now_iso(),
    }

    cache.set(url, result)
    return result
```

### HTML to text extraction

The HTML-to-text pipeline converts web pages to clean readable text:

```
Pseudocode:

function html_to_text(html):
    # Use a markdown conversion library (like turndown/html-to-md)
    # This preserves structure better than plain text extraction

    # 1. Remove non-content elements
    remove_elements(html, ["script", "style", "nav", "header", "footer",
                           "aside", "iframe", "noscript"])

    # 2. Convert to markdown (preserves headings, lists, links, code blocks)
    markdown = html_to_markdown(html)

    # 3. Clean up excessive whitespace
    markdown = collapse_whitespace(markdown)

    return markdown
```

### Caching

- **Key:** URL (exact match)
- **TTL:** 15 minutes
- **Storage:** in-memory (session-local, not persisted)
- **Purpose:** avoid re-fetching the same URL within a session (common when agent re-reads a page)

### Redirect handling

- **Same-host redirects:** follow automatically (up to 5 hops)
- **Cross-host redirects:** return the redirect target URL to the agent, let it decide whether to follow
  - Reason: prevents open-redirect abuse, keeps agent aware of domain changes

### Error handling

- **Timeout (30s):** return error, don't retry
- **HTTP errors (4xx, 5xx):** return status code and message
- **Connection refused:** return error with URL
- **Unsupported content type:** return error listing the type
- **Content too large:** truncate at 100KB with notice

## Security considerations

- No arbitrary URL construction by the agent — URLs should come from user messages, search results, or prior fetch results
- Same-host redirect following only (cross-host returns redirect info)
- No cookie/auth persistence between fetches
- User-Agent header identifies dreb (honest crawling)
- No JavaScript execution — static HTTP fetch only

## Tool properties

Both tools are:
- **Concurrency-safe:** multiple calls can run in parallel
- **Read-only:** no side effects beyond the HTTP requests
- **Available in subagents:** research subagents commonly use both
