# Agent Instructions

## Request Scope

- Questions authorize investigation and explanation, not implementation or artifact generation. Use read-only diagnostics and research as needed.
- Do not modify files, generate assets, or start implementation unless requested.

## Protected Areas

- Ask before large refactors, migrations, or compatibility shims unless already explicitly requested.
- When editing JSON, preserve the file's existing formatting and merge changes into it rather than overwriting or reformatting unrelated content; if list members are inline, keep them inline.

## Design and organization

- Follow the repository's language, architecture, formatting, and naming conventions.
- Hide implementation details behind clear APIs; avoid speculative abstractions and extension points.
- Organize code by responsibility, following the existing structure without adding unnecessary hierarchy.

## Logging

- Log failures and unexpected early exits, not routine no-ops. Match severity to impact and avoid repeated messages.
- Use warning-level logging for expected but undesirable bail-outs, such as missing optional runtime dependencies, missing content, invalid state, or no valid spawn/location being available.
- Use error-level logging for unexpected failures, corruption, or impossible states—not normal validation failures or rejected actions.
- Log interesting events at information level, or at least verbose level for high-frequency events, so logs can explain meaningful state changes.
- Keep bail-out log messages specific enough to identify the object/content key/state involved, but avoid noisy per-frame logs in hot-path loops unless the condition is throttled or state-gated.

## Performance

- Avoid unnecessary allocations and repeated collection scans in hot paths. Measure performance tradeoffs when the better approach is unclear.

## Verification scope

- After changes, run relevant tests and configured lint/format checks; report failures and anything not verified.
- Prefer minimal controlled setups, without bypassing the behavior being tested.
- Stop once the question is answered, and recheck only what later edits affect.

## Documentation

- Use documentation comments on public members when appropriate.
- Very simple classes and self-explanatory members do not need documentation.

## Prose and comments

- Write plain, direct English, not technical-manual prose. Avoid wording like "provenance", "materialize", "retain as", or "source of truth" when simpler language is equally precise.
- Keep comments short and focused on non-obvious reasons, constraints, or workarounds—not what the code already says.

## Unit Tests

- Follow Arrange, Act, Assert.
- Do not bypass the behavior being tested with mocks.

## Working tree safety

- Always inspect `git status` before making repository changes.
- Preserve all pre-existing user changes.
- Do not modify, revert, format, stage, or otherwise alter unrelated pre-existing changes.
- If the working tree is dirty, scope broad automated fixers and formatters to task-relevant files whenever practical.
- After making changes, distinguish your edits from changes that existed before the task.
