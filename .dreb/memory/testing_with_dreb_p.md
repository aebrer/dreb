---
name: testing-with-dreb-p
description: After building, test new features by launching dreb -p and asking it to QA from the inside
type: good-practices
---

After `npm run build`, you can test new dreb features by running `dreb -p` (plain mode) and asking that agent to exercise the feature as a "man on the inside" QA tester. It uses the freshly built binary, so it will actually run the new code and report back what it sees.

**Why:** Manual testing against the real binary catches issues that unit tests miss — prompt wording, tool rendering, end-to-end behavior. The agent can report exactly what it experiences.

**How to apply:** After implementing and building a feature that changes tool behavior, prompt wording, or system prompt content, launch `dreb -p` and ask it to use the feature and describe what it sees.
