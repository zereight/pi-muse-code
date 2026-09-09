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
  `MAX_PRIOR_CHARS` in `src/fold.mjs`); older turns are dropped with a note.
- Non-text blocks (toolCall args, images) are skipped, not serialized.

## Limits

- Still a one-shot `muse exec` under the hood: history arrives as folded text,
  not a resumed Muse session. Good for mid-chat model switching, not a full
  chat-API replacement.

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
