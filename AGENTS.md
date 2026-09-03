# torrent-tui agent guide

## Quick commands

```sh
bun install
bun dev
bun test
bunx biome check ./src ./tests
bunx tsc --noEmit
```

## Stack

- **Runtime:** Bun.
- **Language:** TypeScript with strict checking and native ES modules.
- **UI:** OpenTUI Core with the OpenTUI React binding. JSX uses OpenTUI through `jsxImportSource`.
- **Backend:** Transmission daemon accessed through its RPC API.
- **Tests:** Bun's built-in test runner (`bun:test`).
- **Formatting and linting:** Biome.
- **Package manager:** Bun with `bun.lock`.

## Architecture

```text
src/
├── index.tsx                         # OpenTUI application bootstrap
└── transmission/
    ├── client.ts                     # Transmission RPC client and session handling
    └── types/
        ├── session.ts                # Transmission session response types
        └── torrent.ts                # Torrent list, reference, and add-result types

tests/                                # Unit and future integration tests
```

## Distribution

## Version control workflow

- Start each task that is big on a new branch from `v2` using a concise type/scope branch name otherwise direct commits for small tasks.
- Divide work into coherent phases by subfeature or subtask, using focused Conventional Commits in `type: summary` form.
- Open pull requests against `v2` with concise, human-readable titles without commit-type prefixes.
- Keep PR descriptions concise and use a `Summary` heading containing the overall change; rely on CodeRabbit for detailed commit summaries.

## Testing

- Use Bun's built-in test runner.
- Keep unit tests under `tests/unit/` and reserve `tests/integration/` for tests that require Transmission or another external service.
- Unit tests should not require a running Transmission daemon.
- Test public behavior and meaningful RPC requests instead of private implementation details or TypeScript-only types.
- Restore global mocks after each test and keep test state isolated.
- Await real asynchronous operations; do not use arbitrary delays to make asynchronous tests pass.
- Use temporary directories for future filesystem tests rather than writing test data into the repository.
- Keep OpenTUI renderer tests separate from backend tests and release renderer resources after each test.
- Add or update a focused test when observable behavior changes.
- Do not add another test framework or coverage policy until the project has a concrete need for it.
