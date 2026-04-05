---
name: Doc updates are critical
description: Documentation updates (json.md, rpc.md, sdk.md, spec) must be included in the PR that changes behavior, not deferred
type: good-practices
---

Doc updates are critical and must be included in the same PR that changes behavior. Don't defer documentation to follow-up issues.

**Why:** Drew considers docs part of "done." External consumers rely on json.md, rpc.md, sdk.md, and the spec to understand the protocol and API.
**How to apply:** When making changes that affect protocol events, tool schemas, or public APIs, update all relevant documentation files in the same PR. Include docs in the review checklist, not as optional follow-ups.
