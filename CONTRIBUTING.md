# Contributing to dreb

Contributions are welcome, including AI-assisted contributions.

## Workflow

Every change should move clearly through GitHub:

1. Start with a tracking issue that describes the problem and records the agreed scope.
2. Plan the change before implementation. Ask before expanding the agreed scope.
3. Develop on a focused branch and keep progress connected to the issue.
4. Validate the complete change and review your own diff.
5. Open a standalone PR that resolves one clear issue, includes the necessary tests and documentation, and is ready for maintainer review.

AI-assisted contributions must use a GitHub-aware development workflow such as [mach6](packages/coding-agent/docs/mach6.md), mach10, or an equivalent process that records the issue, plan, implementation, validation, and self-review on GitHub. The specific tool is not important; a traceable and reviewable result is.

For bugs, provide a minimal reproduction, test case, or sanitized log when possible. Fix the observed problem first rather than redesigning adjacent systems without evidence or maintainer agreement.

## Keep pull requests reviewable

If you are a guest contributor or are still new to contributing to dreb:

- Keep each PR small, focused, and easy to review.
- Do not grow the PR while responding to review. Discuss newly discovered work first and usually track it separately.
- Ask before beginning a broad refactor or a change spanning several systems.

Large or complex PRs are unlikely to be accepted, and may not receive detailed review, unless a repo owner or trusted contributor is leading or has agreed to the work in advance.

## Development requirements

See [AGENTS.md](AGENTS.md) and the [development guide](packages/coding-agent/docs/development.md) for setup, build, test, and repository requirements. CI must pass before merge.
