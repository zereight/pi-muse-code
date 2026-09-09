# pi-muse-code-context-fold

Pi extension that keeps [pi-muse-bridge](https://github.com/ferdousbhai/pi-muse-bridge)
conversations coherent when you switch models mid-session (e.g. grok → muse → grok).

For pi-muse-bridge **via Muse Code CLI, not Muse OAuth**: the bridge forwards only
the latest user message to a one-shot `muse exec`, so turns handled by other models
never reach Muse. This extension folds the Pi session history into that last user
message on `muse-code` turns only.

## Requirements

- Pi 0.85.1 (verified; other 0.8x versions likely work)
- `npm:pi-muse-bridge` 0.3.0

## Install

```sh
# from source (until published)
pi install ~/pi-muse-code-context-fold
# or after cloning your fork
pi install git:github.com/zereight/pi-muse-code-context-fold
```

Then reload the running Pi session:

```sh
/reload
```

## Behavior

- Hooks Pi's `context` event; only `muse-code` provider turns are touched.
- Previous turns (user / assistant with `provider/model` label / tool results /
  compaction and branch summaries) are prepended to the latest user message
  behind a `<!-- pi-muse-prior-context -->` marker.
- Idempotent: an already-folded message is left alone.
- Bounded: keeps the newest 20 turns and 12,000 chars (`MAX_PRIOR_TURNS`,
  `MAX_PRIOR_CHARS` in `src/fold.mjs`). Any single prior message (e.g. a huge
  tool result) is additionally capped at 2,000 chars (`MAX_MESSAGE_CHARS`) so
  one big tool dump can't crowd the real conversation out of the budget.
- Non-text blocks (toolCall args, images) are skipped, not serialized.
- Tracks one muse `--session-id` per Pi session (`~/.local/state/pi-muse-code-context-fold/sessions.json`)
  and attaches it via `<!-- pi-muse-session-id:<uuid> -->` on every
  `muse-code` turn.
- By default it still folds full prior history on **every** `muse-code`
  turn, same as 0.1.0 — that's the only safe default against stock
  `pi-muse-bridge` 0.3.0, which spawns a fresh, session-less `muse exec`
  each turn and would lose everything if this extension stopped re-sending
  history.
- Set `PI_MUSE_BRIDGE_RESUMES_SESSION=1` only once your `pi-muse-bridge`
  build reads that marker and passes it through as `muse exec --session-id`
  (verified: `muse exec --session-id <uuid>` genuinely resumes a durable
  session across separate process invocations — see `~/.local/share/muse/sessions/`).
  With that env var set, this extension folds full history only on the
  first `muse-code` turn of a Pi session and just re-attaches the marker
  on later turns, since the resumed muse session already remembers them.

## Limits

- Still a one-shot `muse exec` under the hood: the first switch into
  `muse-code` in a Pi session arrives as folded text, not a resumed Muse
  session, because no earlier turn ran through Muse yet — that first fold
  is unavoidable regardless of `PI_MUSE_BRIDGE_RESUMES_SESSION`.
- `PI_MUSE_BRIDGE_RESUMES_SESSION=1` requires a `pi-muse-bridge` patch that
  does not exist upstream yet (add a `sessionId` to `MuseRunRequest`, parse
  `pi-muse-session-id` out of the prompt in `latestUserText`, and pass
  `--session-id` in `getMuseExecArgs`). Until that lands, leave the env var
  unset; the marker is then a harmless inert comment in the prompt.

## Origin

Forked from [pi-muse-bridge](https://github.com/ferdousbhai/pi-muse-bridge)
by ferdousbhai (MIT). This is a companion extension, not a GitHub fork:
no upstream code is copied; it hooks Pi's `context` event so the bridge's
one-shot `muse exec` prompts receive the folded Pi session history.

## Test

```sh
node --test test/fold.test.mjs
```

## License

MIT
