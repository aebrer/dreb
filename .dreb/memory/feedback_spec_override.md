---
name: Spec follows implementation
description: The spec is a living document that follows the implementation, not the other way around — new features override the spec
type: good-practices
---

The spec (docs/spec-subagents.md) follows the implementation, not the other way around. When a new feature ships, the spec must be updated to match — not the reverse. Drew has override privilege for the spec, so if a feature is a "must have," it simply means the spec was incomplete. Don't treat spec inconsistencies as blockers or concerns.

**Why:** Drew defines the spec iteratively as features are built. The spec documents what exists, it doesn't gate what can be built.
**How to apply:** When reviewing PRs, treat spec updates as required cleanup (fix the spec to match the code), not as design concerns. Never flag "spec doesn't mention this" as a problem with the implementation.
