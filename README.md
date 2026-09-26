# pi-muse-code

Pi extension that registers a `muse-code` model provider backed by the
Muse Code agent, through the TypeScript SDK
[`@muse-code/sdk`](https://www.npmjs.com/package/@muse-code/sdk) over
**MSP** (the Muse Session Protocol) against a long-lived `muse serve` host.

Switching models mid-session (e.g. grok → muse → grok) resumes the same
muse session instead of re-sending the whole conversation as text on
every turn.

Uses your local `muse` CLI login, not the Muse OAuth API.

## Requirements

- Pi 0.85.1 (verified; other 0.8x versions likely work)
- Node 20 or newer (the MSP SDK's floor)
- The `muse` CLI on `PATH` (or `PI_MUSE_BINARY` pointing at it), logged in.
  The SDK drives it as `muse serve`. Muse 1.3.x pairs with SDK 1.3.x; a
  protocol-fingerprint mismatch is a warning, not a failure.
- No `pi-muse-bridge` alongside this package; remove it if installed
  (`pi remove npm:pi-muse-bridge`) to avoid two extensions registering the
  same `muse-code` provider id.

## Install

```sh
# from source (until published)
npm install            # pulls @muse-code/sdk for the extension
pi install ~/pi-muse-code
# or after cloning your fork
pi install git:github.com/zereight/pi-muse-code
```

Then reload the running Pi session:

```sh
/reload
```

## Behavior

- Registers the `muse-code` provider directly (`pi.registerProvider("muse-code", ...)`),
  with models read from Muse's local model catalog.
- **One `muse serve` host per Pi process** (`src/host.ts`), spawned lazily on
  the first `muse-code` turn and shut down on `session_shutdown`. Turns are
  `turn/start` commands on an open session, so a turn pays no process spawn
  or handshake.
- **One muse session per Pi conversation**, keyed by the Pi session file. Its
  muse session id is written to `~/.pi/agent/muse-code-sessions/<hash>` so a Pi
  restart (or `/resume` of an old conversation) resumes the same muse session
  instead of starting cold. A marker that no longer resolves — pruned log, or
  `sessionInUse` from another live host — falls back to a fresh session.
- The first `muse-code` turn of a fresh session folds the full prior Pi
  conversation (other models included) into the prompt, since there's nothing
  to resume yet. Every later turn sends the newest user message plus a
  **catch-up** of the turns other models ran since muse last answered
  (`buildCatchUpPrompt`), so grok → muse → grok → muse keeps muse current
  without re-sending what it already saw.
- **Switching muse models keeps the session**: a different muse model id is
  applied with `session/setModel`, and the next turn runs on it with the same
  memory. A resumed session gets the selected model the same way. When the
  host rejects the model (`invalid_model`), a fresh session with the
  conversation folded in takes over.
- Bounded fold: keeps the newest 20 turns and 12,000 chars
  (`MAX_PRIOR_TURNS`, `MAX_PRIOR_CHARS` in `src/fold.ts`). Any single
  prior message (e.g. a huge tool result) is additionally capped at 2,000
  chars (`MAX_MESSAGE_CHARS`) so one big tool dump can't crowd the real
  conversation out of the budget.
- Non-text blocks (toolCall args, images) are skipped, not serialized.
- Answer text streams from typed `item/delta` events; tool output stays out
  rather than rendered as the reply.
- **Progress is visible**: reasoning summaries stream into a Pi thinking
  block, and tool calls, shell runs, subagents, and workflow transitions
  add one line each (`tool <name> <args>`, outcome on completion). The live
  working line shows the latest activity, so a muse turn never looks stuck.
  Progress is capped (200 lines, 20,000 chars per turn) and never becomes
  Pi tool calls.
- Token usage comes from the turn's own counters, falling back to the
  session's counted-once `session/tokenUsage` when a host reports no
  per-turn aggregate.
- **Approvals**: `PI_MUSE_SANDBOXED=1` or `--muse-sandboxed` runs the host with
  Muse's sandbox on and starts sessions in `onRequest` approval mode; each
  host approval request is answered through Pi's own selector. Deny-only
  choices are picked when no UI is available. Without the flag the host runs
  sandbox-free in `allowAll` mode.
- **Aborting a turn** sends `turn/interrupt` to the host, so the agent stops
  working instead of silently finishing in the background.
- Host stderr is not parsed; the SDK reports failures through typed errors
  (`MuseHostDiedError`, `MspError`), and a dead host is respawned on the next
  turn.

## Limits

- A resumed session's earlier items are **not** in the client-side fold: the
  SDK has not shipped snapshot ingestion yet. The host still has the whole
  conversation — model memory is intact — but only items from the current
  process show up in `session.fold`.
- Catch-up shares the fold bounds, so a long detour through other models
  reaches muse truncated to the newest turns.
- The first `muse-code` turn in a Pi process pays the `muse serve` startup
  (a few seconds). Later turns reuse the host.
- One host per Pi process. Two Pi processes on the same conversation will
  fight over the session; the loser refolds into a fresh session.
- This package only owns the `muse-code` chat provider used by `/model`;
  Pi's separate Task-subagent delegation feature is out of scope here.
  `agents/muse-spark.md` in this repo is just the system prompt used for
  `muse-code` chat turns (MSP has no system-prompt parameter, so it is
  still prepended to each prompt).

## Origin

Model catalog reading and provider structure adapted from
[pi-muse-bridge](https://github.com/ferdousbhai/pi-muse-bridge) by
ferdousbhai (MIT).

## Test

```sh
node --test test/*.test.mjs     # includes an echo-provider MSP round trip (skipped without `muse`)
node scripts/smoke-live.mjs     # optional: real provider, spends tokens
```

`test/msp.test.mjs` starts real `muse serve` hosts against Muse's `echo`
provider, so it is free but slow (~45s), and it leaves session records in
Muse's own session log directory. The echo route only accepts `muse-spark`,
so a real switch between catalog models is checked by the live smoke script.

There is no build step; Pi loads the extension through jiti. A strict
typecheck is still worth running after changes:

```sh
npx tsc --noEmit --allowImportingTsExtensions --module nodenext \
  --moduleResolution nodenext --target es2022 --strict --skipLibCheck src/*.ts
```

## License

MIT
