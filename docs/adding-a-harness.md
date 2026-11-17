# Adding an agent harness

The ordered steps from `docs/harness-additions.md` ("Adding a harness"),
with the files a new adapter touches now that the registry is the source
of truth (P2). Read that decision record first; it explains why each step
exists.

## Steps

1. **Pin the CLI and fill the capability sheet** from `--help` and a
   hand-run pty probe (`scripts/record-harness-status.mjs`): session flags,
   7501 dialect per scenario, delivery channels and whether each works when
   idle, MCP injection, permission flag, trust prompts, session-file layout,
   usage format, review integration, binary aliases, detached child
   processes it leaves behind.
2. **Record every deviation** from the standard path as a decision row in
   `docs/harness-additions.md`.
3. **Adapter**: descriptor + capabilities + usage reader, and
   `interpretProgramStatus` with the recorded quirks.
4. **Contract rows, fake, e2e**: `contracts/<id>.ts` rows, `fake-<id>.ts`
   replaying them, `<id>-sessions.spec.ts`, T3 assertions per row, dialect
   fixtures.
5. **Real smoke (T4)** scenarios for the harness; run it; commit the marker.
6. **Doctor, onboarding, Settings, diagnostics, review support and the tool
   catalog need no edits.** If one does, the descriptor is missing a field:
   add the field, not a special case.

## Files a new adapter touches

| File | What goes there |
|---|---|
| `packages/core/src/harness/<id>-adapter.ts` | The `HarnessAdapter`: `descriptor` (id, label, binary aliases in lookup order, `commandEnv` from `harnessCommandEnvName(id)`, install/upgrade one-liners, `versionArgs` + `parseVersion`, `minVersion`, `verifiedVersion`, `configDir`, `reviewPieces`, `isShim`), `capabilities` (must agree with `messaging`), launch spec, presence, `interpretProgramStatus`. Shared helpers: `harness/descriptor.ts`, `harness/adapter-common.ts`, `harness/toml-value.ts` (CLIs configured with TOML `-c` overrides). A harness that picks its own session ids declares `capabilities.sessionId: "learned"` (core then persists no placeholder id; a session-start hook reports the real one through the `session_start` op); one that can hand a message to a live session from outside implements `deliverCommand(kind, sessionId, text)` (the app runs it, see `main/harness-delivery.ts`; Codex: `codex queue`). `expectedSessionFile` receives the cwd as given; resolve it with `canonicalPath` (agents key their files by the real path). |
| `packages/core/src/access/<id>-*.ts` | Its resource access: model catalog, transcripts, session usage reader. |
| `packages/core/src/harness/registry.ts` | One line in `createHarnessRegistry`'s built-in list. |
| `packages/app/e2e/contracts/<id>.ts`, `packages/app/e2e/fake-<id>.ts`, `packages/app/e2e/<id>-sessions.spec.ts` | Contract table, the fake replaying it, the T2 spec. |
| `packages/core/tests/fixtures/status/<id>/<version>/*.txt` | Recorded 7501 dialect fixtures (S1): `scripts/record-harness-status.mjs --harness <id> --scenario all [--command <pinned binary>]`. |
| `packages/app/tests/real-cli-smoke.test.ts` | T3: `PINNED` entry + one `rowIt` per keyless row (keyless model stubs: Messages API for Claude/Pi, Responses API for Codex). |
| `packages/app/e2e/real-smoke.spec.ts` | T4 cases for the harness (Setup ready, Review, the S4 presence scenario). |

`packages/core/tests/harness-contract.test.ts` picks the adapter up from the
registry by itself ("descriptor complete": every field filled,
`minVersion <= verifiedVersion`, capabilities consistent with messaging).
A review piece the harness needs that does not exist yet (a new Plannotator
skill) is added to `engines/review-support.ts` and its probe access.

## Bumping a pinned version

Run the real-CLI tier on the new version, re-record the dialect fixtures,
then raise `verifiedVersion` in the descriptor (P7). Raise `minVersion` only
when the adapter starts depending on something newer.
