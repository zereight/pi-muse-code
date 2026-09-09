# pi-muse-code-context-fold

Pi extension that registers a `muse-code` model provider backed by the
Muse Code CLI (`muse exec`), and keeps it coherent when you switch models
mid-session (e.g. grok → muse → grok) by resuming a real muse session
instead of re-sending the whole conversation as text on every turn.

Originally a companion extension for
[pi-muse-bridge](https://github.com/ferdousbhai/pi-muse-bridge) (see
`## Origin` below). As of 0.3.0 it no longer depends on that package: it
registers the `muse-code` provider itself.

For Muse Code CLI, not Muse OAuth.

## Requirements

- Pi 0.85.1 (verified; other 0.8x versions likely work)
- The `muse` CLI on `PATH` (or `PI_MUSE_BINARY` pointing at it), logged in
- No `pi-muse-bridge` needed or wanted; remove it if installed
  (`pi remove npm:pi-muse-bridge`) to avoid two extensions registering the
  same `muse-code` provider id.

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

- Registers the `muse-code` provider directly (`pi.registerProvider("muse-code", ...)`),
  with models read from Muse's local model catalog.
- Tracks one muse `--session-id` per running Pi process (`src/session.ts`).
  The first `muse-code` turn folds the full prior Pi conversation (other
  models included) into the prompt, since there's nothing to resume yet.
  Every later `muse-code` turn just sends the newest user message, because
  the resumed muse session (verified against the real `muse` CLI: two
  separate `muse exec --session-id <same uuid>` calls land in one durable
  `~/.local/share/muse/sessions/.../session.jsonl`) already remembers
  everything before it.
- Bounded fold: keeps the newest 20 turns and 12,000 chars
  (`MAX_PRIOR_TURNS`, `MAX_PRIOR_CHARS` in `src/fold.ts`). Any single
  prior message (e.g. a huge tool result) is additionally capped at 2,000
  chars (`MAX_MESSAGE_CHARS`) so one big tool dump can't crowd the real
  conversation out of the budget.
- Non-text blocks (toolCall args, images) are skipped, not serialized.
- `PI_MUSE_SANDBOXED=1` or `--muse-sandboxed` runs Muse with its sandbox
  and approval prompts enabled instead of `--yolo`.

## Limits

- One muse session per Pi *process*, not per saved Pi session file. If Pi
  restarts and you `/resume` an old conversation, this cold-starts a new
  muse session and folds once more on the next `muse-code` turn. That's an
  acceptable simplification, not a bug: the alternative (persisting the
  mapping to disk, keyed by Pi's session id) adds real complexity for a
  case that just costs one extra fold.
- The very first switch into `muse-code` in a Pi session always arrives as
  folded text, not a resumed Muse session, because no earlier turn ran
  through Muse yet.
- Does not install the `agents/muse-spark.md` subagent definition into
  `~/.pi/agent/agents/` the way `pi-muse-bridge`'s `/muse-setup` command
  did. This package only owns the `muse-code` chat provider used by
  `/model`; Pi's separate Task-subagent delegation feature is out of scope
  here. `agents/muse-spark.md` in this repo is just the system prompt used
  for `muse-code` chat turns.

## Origin

Forked from [pi-muse-bridge](https://github.com/ferdousbhai/pi-muse-bridge)
by ferdousbhai (MIT). 0.1.0–0.2.0 were a companion extension that only
hooked Pi's `context` event to patch pi-muse-bridge's prompts from the
outside. 0.3.0 ports pi-muse-bridge's provider/runtime/catalog code
directly into this package (still MIT, same author's original design) so
it can resume a real muse session natively instead of working around
another package's one-shot-only behavior.

## Test

```sh
node --test test/*.test.mjs
```

## License

MIT
