# jreb-pi-extensions

Custom extensions for [pi](https://github.com/earendil-works/pi).

## Extensions

### Custom Footer (`custom-footer.ts`)

Colorful statusline showing token usage, context window progress, git branch, and current model.

**Features:**
- **↑ input / ↓ output** — cumulative token counts with colored arrows; `R`/`W` show cache read/write totals when the model uses prompt caching (pi-ai's `input` excludes cached tokens)
- **Context bar** — compaction-aware context estimate from pi core (`ctx.getContextUsage()`), visual progress bar with color-coded warning levels (green < 70%, yellow 70-90%, red > 90%). Shows `?` right after a compaction until the next model response
- **● branch** — current git branch (± and red when dirty)
- **model** — active model name

![footer example](./images/footer.png)

### Herdr Telegram Ask (`herdr-telegram-ask.ts`)

**Answer pi's `ask_user_question` from Telegram** — or at the terminal, whichever answers first. When a question opens you get a rich message (questions with numbered options, host/project/session); tapping an option or replying with text answers it remotely (`✅ answered via Telegram`), answering at the terminal edits the message to `⌨️ answered at the terminal`.

**This file is the provider-of-record for `ask_user_question`** (ADR-0002): it registers the tool unconditionally on load, everywhere — no Herdr required. Without a Telegram config (or after `/telegram off`) it is simply the local questionnaire, byte-compatible with the upstream tool. If you previously installed the npm package `@juicesharp/rpiv-ask-user-question`, **remove it** (`pi remove npm:@juicesharp/rpiv-ask-user-question`) — alongside this file it can only produce a duplicate-tool warning banner and lose.

**How it works:** the tool contract is a frozen, byte-compatible clone of [`@juicesharp/rpiv-ask-user-question`](https://github.com/juicesharp/rpiv-mono) `2.8.0`; the handler races the Telegram wizard against a local dialog. If Telegram is unreachable, it degrades to local-only answering. ADR with the full rationale: see the repo memory notes.

> **⚠️ Drift duty — check upstream periodically.** The clone is frozen at rpiv `2.8.0` and upstream is not installed, so nothing warns you automatically. Run
> ```sh
> npm view @juicesharp/rpiv-ask-user-question version
> ```
> occasionally (e.g. after a `pi update` or once a month). If it is newer than `CLONED_RPIV_VERSION` in the source, re-diff the clone (input schema, runtime validation, response envelope, description/snippet/guidelines) and bump the constant. `/telegram status` prints the current provenance and this reminder.

**Setup** (one-time; Telegram answering works with or without Herdr):
1. Create a bot with [@BotFather](https://t.me/BotFather) → copy the token.
2. In pi: `/telegram setup` — paste the token, then send `/start` to your bot in Telegram. The chat is discovered automatically; config is saved to `~/.pi/agent/herdr-telegram.json` (0600).

**Commands:** `/telegram status` · `on` · `off` · `test`.

- Only the configured chat may answer; every other chat is ignored. Free-text replies become custom answers ("Type something." row). multiSelect questions get toggle buttons + `✅ Submit`.
- **Multi-question asks end in a review step** (mirroring upstream's Submit tab, single-question asks submit immediately): after the last answer the phone shows `✓ Submit` + `✕ Leave for terminal` — reply with text (or the terminal walker's `✎ Add note`) to attach a **global note** that rides the envelope as `global note: …` and survives declines in `details`. `🗑 Clear note` removes it. Per-question `user notes:` are echoed by the envelope when present (upstream authors them via its full-screen TUI; our lean dialogs don't — known divergence).
- While a question is open, the message refreshes its `⏳ waiting` line once a minute (stops after 30 min).
- `/telegram status` shows the upstream-vs-clone drift hint (see **Drift duty** above) plus config/tool state.
- `/telegram off` disables remote answering immediately — the tool stays registered and serves local-only dialogs from the next question on. No `/reload` needed.

**Env overrides:** `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (both or neither; they win over the file — `/telegram on|off` only works with a file config).

**Shared plumbing:** the Telegram client, config file and the single per-process `getUpdates` loop (PollHub) live in `herdr-telegram-core.ts`; this file re-exports the moved names, and the wizard's remote window subscribes to the shared hub instead of polling on its own (buttons from `herdr-telegram-progress` and wizard taps route through one loop — no mutual `409`s inside a process).

**Privacy:** question content and answers transit Telegram's cloud. That is the point of the tool — but it is opt-in per the config above.

**Manual E2E checklist** (run after install/upgrade, ~5 min):

1. **Single-select from phone** — trigger a one-question ask; tap an option in Telegram → message edits to `✅ answered via Telegram`, session shows the answer envelope.
2. **multiSelect from phone** — toggle two options, `✅ Submit` → answer envelope lists both labels.
3. **Free text** — reply to the message with plain text → arrives as a custom answer.
4. **Leave for terminal** — tap `✕ Leave for terminal`, answer at the TUI → message edits `⌨️ answered at the terminal`.
5. **Decline at terminal** — press Esc locally → envelope declines; message edits `✖ declined at the terminal`.
6. **Multi-question wizard** — a 2+ question ask walks the phone through questions one at a time (progress lines above the keyboard).
7. **Concurrent sessions** — open questions in two pi processes at once → both remain locally answerable; one process's polling backs off (Telegram `409`) — phone answering may be briefly slow, never blocked.
8. **Network loss** — go offline mid-question → terminal answering unaffected; the open Telegram message simply never gets its ✅ edit, and later taps on it spin out (polling already stopped) — expected.
9. **Herdr readout** — while a question is open, the Herdr pane shows red/blocked (the sibling `herdr-blocked-on-question` extension tracks the tool by name and keeps working).
10. **Sanity** — `/telegram status` shows `tool: ask_user_question owned by this file`; `/telegram test` send+edit round-trips.
11. **Global note** — a 2+ question ask → after the last answer the phone shows the review step; reply with text (note shown as `📝 note:`), `🗑 Clear note`, then re-note and `✓ Submit` → envelope ends with `global note: <text>.`; at the terminal the same ask offers `✓ Submit` / `✎ Add note` after the last question.

### Herdr Telegram Progress (`herdr-telegram-progress.ts` + `herdr-telegram-core.ts`)

**Track pi agent runs from Telegram.** While a run is open (`agent_start` … `agent_settled`) you get one **silent** live message per run — edited in place at most every ~10 s — showing recent tool activity, turn count, elapsed time and token totals; when the run settles you get an **audible** summary (turns · tools · errors · elapsed · tokens · cost · last answer preview). The first mid-run tool error sends one audible `⚠️` ping per run. Blocking dialogs from *other* extensions (`ui.confirm`-style gates, wizards) ping `🔔 pi is blocked on a dialog` — notify-only, since pi has no API to answer foreign dialogs remotely.

```
🚀 run · jreb-pi-extensions · plan-tg
├── ✅ bash · npm run typecheck
└── ⚙️ bash · npx tsx scripts/smoke-telegram.mts · 34s

⏳ turn 3 · 4m 12s · ↑12.3k ↓4.5k tok
[📋 tasks] [⏹ stop] [🔁 refresh]
```

**Buttons** (live on the run message; routed through the shared poll hub):
- `📋 tasks` — the session's todo list (replayed read-only from the last `todo` tool result; ✔ done · ◐ in progress · □ pending): short lists (≤3) as an inline toast, longer lists as a message with **one task per line**.
- `⏹ stop` — aborts the current agent run (`ctx.abort()`); the settle summary reads `⏹ stopped`.
- `🔁 refresh` — immediate status edit, bypassing the throttle.

**Commands:** `/progress status` · `on` · `off` · `test` (60 s live button window for E2E).

- Enabled by default once the ask config exists (`~/.pi/agent/herdr-telegram.json`); the optional `progress` flag in that file (or `/progress off`) disables it — takes effect on the next run, no `/reload`.
- Env force-off: `TELEGRAM_PROGRESS=0`.
- Dialog pings fire only **mid-run** (if you're running commands interactively you're at the terminal anyway) and are suppressed while `ask_user_question` is open — its wizard already messages.
- **Concurrent sessions:** two pi processes share one bot token, so `getUpdates` can collide — taps on the other process's buttons get a toast naming the owner; retry shortly. Local work is never blocked (same stance as the ask wizard's `409` handling).

**Privacy:** activity lines carry one-line summaries only (shell commands, file paths) — never file contents. They still transit Telegram's cloud; disable with `/progress off` if that's not acceptable.

**Manual E2E checklist** (~5 min, after `/telegram setup`):

1. **Live run** — kick off a multi-step task → silent run message appears, edits as tools complete.
2. **Settle buzz** — on completion a new message arrives (turns/tools/tokens/cost + last answer preview).
3. **Tasks** — create todos (`todo` tool) during a run → `📋 tasks` toast lists them with ✔/◐/□.
4. **Stop** — tap `⏹ stop` mid-run → run aborts, summary reads `⏹ stopped`.
5. **Refresh** — tap `🔁 refresh` → immediate edit with current state.
6. **Dialog ping** — while a run is open, an extension `ctx.ui.confirm` dialog → audible 🔔 ping, ✅ edit on resolve (ask_user_question dialogs must NOT ping — the wizard covers them).
7. **Error ping** — a failing tool mid-run → one audible ⚠️, settle summary counts `N ⚠️`.
8. **Concurrent sessions** — runs in two pi processes → both tracked; cross-taps answer `owned by …`.
9. **Sanity** — `/progress status` shows enabled/instance/poll-hub state; `/progress test` round-trips buttons.

### Herdr Blocked on Question (`herdr-blocked-on-question.ts`)

> **Status: provisional** — a stopgap companion to the Herdr-managed
> `herdr-agent-state.ts`. See *Status & what still needs addressing* below.

Companion extension for [Herdr](https://herdr.dev) users. While pi has an
`ask_user_question` open, it tells Herdr the agent is **blocked** (needs
attention) so hardware readouts — e.g. the
[opendeck-herdr](https://github.com/JohannesBertens/opendeck-herdr) Stream Deck
plugin — turn **red** instead of showing **busy/blue**.

**Important:** it does **not** modify the `ask_user_question` tool. It is a
listener that watches the tool's execution lifecycle (`tool_execution_start` /
`tool_execution_end` for `toolName === "ask_user_question"`) and emits a
`herdr:blocked` event on pi's shared event bus, which the existing
`herdr-agent-state` bridge already maps onto Herdr's `blocked` state. No tool
source is touched.

**Prerequisites:** `herdr integration install pi` must already be installed
(it ships `herdr-agent-state.ts`, which consumes the signal). Inert unless pi is
running under Herdr (`HERDR_ENV=1`).

## Installation

### Option 0: One-liner (install or update from GitHub)

```bash
curl -fsSL https://raw.githubusercontent.com/JohannesBertens/jreb-pi-extensions/main/install.sh | sh
```

Overwrites the extension files in `~/.pi/agent/extensions/`, so re-running it updates to the latest version. Set `PI_EXTENSIONS_DIR` to target a different folder.

### Option 1: Copy to pi extensions folder

```bash
mkdir -p ~/.pi/agent/extensions
cp *.ts ~/.pi/agent/extensions/
```

In pi, run:
1. `/reload` — pick up the new extension
2. `/footer` — enable the custom footer (toggle off/on with same command)

### Option 2: Symlink from this repo (dev workflow)

```bash
mkdir -p ~/.pi/agent/extensions
for f in ~/projects/jreb-pi-extensions/*.ts; do ln -sfn "$f" ~/.pi/agent/extensions/; done
```

Changes to the files are picked up automatically with `/reload` — no reinstall needed.

### Configure context window

If your model's context window isn't detected, add it to `~/.pi/agent/models.json`:

```json
{
  "providers": {
    "your-provider": {
      "models": [
        { "id": "your-model", "contextWindow": 262144 }
      ]
    }
  }
}
```

## Status & what still needs addressing

`herdr-blocked-on-question` is a **provisional** fix for one specific gap:
`ask_user_question` happens mid-turn, so Herdr (correctly) reports `working` and
readouts show "busy". This extension flips that to `blocked` while a question is
open.

Known limitations to address later:

- **Only `ask_user_question` is covered.** Permission / confirmation prompts
  (`ctx.ui.confirm` / `select` / `input`) and the built-in permission gate are
  **not** — they have no single, stable hook yet.
- **Depends on the Herdr-managed bridge.** It emits `herdr:blocked`, consumed by
  `herdr-agent-state.ts`. If Herdr renames or drops that event contract, this
  silently stops working.
- **Proper upstream fix.** The durable solution is for pi core (or the Herdr
  integration) to emit `herdr:blocked` for *all* awaiting-input states, at which
  point this extension becomes redundant.

## Development

The extensions have **no runtime dependencies** — pi loads the `*.ts` files directly (via jiti, which resolves `@earendil-works/*` imports to pi's own running instance). The `package.json` in this repo is dev-only tooling:

```bash
npm install        # dev-only: typescript + pi packages for typechecking
npm run typecheck  # strict tsc --noEmit against the real pi API
npm run smoke      # renders the footer against stubs; verifies segments & toggles
```

## License

[MIT](./LICENSE)
