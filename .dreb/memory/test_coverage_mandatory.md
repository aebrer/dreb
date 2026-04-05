---
name: test-coverage-mandatory
description: Tests are mandatory for all new features, not optional or deferrable
type: good-practices
---

## Rule: Test coverage is mandatory for new features

**Why:** PR #103 added buddy companion support to Telegram with 4 new source files and zero tests. The mach6 review deferred 4 test-related findings because the telegram package had no test infrastructure. This created a significant coverage gap that could have been caught earlier.

**How to apply:**
- mach6-plan: Every plan must specify what tests to write. If the target package lacks test infrastructure, include setting it up as a deliverable.
- mach6-review: Test coverage gaps should NOT be automatically deferred. Only defer when the gap is truly unrelated to the PR's changes.
- mach6-implement: Tests are part of the deliverable, not an afterthought.

**Tracking issue:** Issue #104 tracks adding telegram test infrastructure.
