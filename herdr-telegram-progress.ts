/**
 * herdr-telegram-progress — Telegram progress tracking for pi agent runs
 * (plans/herdr-telegram-progress.md, M2: push-only layer).
 *
 * While an agent run is open (agent_start … agent_settled) this extension
 * maintains ONE silent Telegram message per run, edited in place at most every
 * MIN_EDIT_INTERVAL_MS (throttled, trailing-edge) showing the recent tool
 * activity, turn count, elapsed time and token totals. On agent_settled it
 * sends an AUDIBLE summary message (edits never buzz — only new messages
 * notify) and closes the run message. The first mid-run tool error sends one
 * audible ⚠️ ping per run. Everything is best-effort: Telegram failures are
 * contained and never disturb the session.
 *
 * Gating: needs a Telegram config (enabled) with progress !== false
 * (config field `progress`, env force-off TELEGRAM_PROGRESS=0); re-checked at
 * every agent_start — /progress on|off takes effect on the next run.
 *
 * Zero runtime dependencies; all network I/O goes through
 * herdr-telegram-core.ts (injectable transport + shared PollHub).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PollHub, type PollLease, type TelegramClient, type TelegramUpdate, escapeHtml, formatElapsed, formatTokens, getChat as coreGetChat, getSharedPollHub, loadConfig, oneLine, progressEnabled, readConfigFile, writeConfigFile } from "./herdr-telegram-core.ts";
import { relayToController } from "./herdr-telegram-command.ts";
import { hostname } from "node:os";
import { basename } from "node:path";

// ---------------------------------------------------------------------------
// Constants / knobs
// ---------------------------------------------------------------------------

/** Telegram guidance is ~1 msg/s per chat; progress edits stay far below. */
export const MIN_EDIT_INTERVAL_MS = 10_000;
/** Max activity lines shown in the run message (middle-truncated beyond). */
export const MAX_ACTIVITY_LINES = 6;
/** Contained-error surfacing: at most one ui.notify per interval. */
const ERROR_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

/** A resolved dialog ping is REUSED (edited back to 🔔) for this long —
 *  consecutive dialogs (e.g. a permission gate per command) don't spam. */
export const PING_REOPEN_MS = 60_000;

/** Buttons owned by this extension: callback_data prefix (never the wizard's hex nonces). */
export const PROGRESS_NONCE_PREFIX = "p:";
/** Max chars for an answerCallbackQuery toast (Telegram ~200 — keep headroom). */
const TOAST_MAX = 190;

export type ProgressAction = "stop" | "tasks" | "refresh";

export function buildProgressCallbackData(instanceId: string, action: ProgressAction): string {
    return `${PROGRESS_NONCE_PREFIX}${instanceId}:${action}`;
}

/** Inline keyboard attached to the run message while the run is live. */
export function buildRunKeyboard(instanceId: string): Array<Array<{ text: string; callback_data: string }>> {
    return [
        [
            { text: "📋 tasks", callback_data: buildProgressCallbackData(instanceId, "tasks") },
            { text: "⏹ stop", callback_data: buildProgressCallbackData(instanceId, "stop") },
            { text: "🔁 refresh", callback_data: buildProgressCallbackData(instanceId, "refresh") },
        ],
    ];
}

// ---------------------------------------------------------------------------
// Tool-activity summaries (one line per tool call; args never leave as-is —
// paths/commands only, never file contents)
// ---------------------------------------------------------------------------

export function summarizeToolCall(toolName: string, args: unknown): string {
    const a = (args ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === "string" ? v : "");
    switch (toolName) {
        case "bash":
        case "powershell":
            return oneLine(str(a.command), 80);
        case "read":
        case "edit":
        case "write":
            return oneLine(str(a.path), 80);
        case "grep":
            return oneLine(str(a.pattern), 60);
        case "find":
        case "ls":
            return oneLine(str(a.path), 60);
        case "subagent":
            return oneLine(str(a.task), 80);
        default:
            return "";
    }
}

// ---------------------------------------------------------------------------
// Tasks button — rpiv-todo branch replay (read-only, defensive)
//
// Mirrors @juicesharp/rpiv-todo's state/replay.ts semantics: the LAST
// toolResult with toolName === "todo" on the branch whose details match the
// persisted TaskDetails shape wins. Shape mismatches are skipped silently —
// drift cousin of the ADR-0002 ask clone duty (rpiv-todo's details shape is
// not covered by any stability policy).
// ---------------------------------------------------------------------------

export interface TodoTask {
    id: number;
    subject: string;
    status: string;
    activeForm?: string;
}

function taskLines(tasks: TodoTask[]): string[] {
    return tasks.map((t) => {
        const mark = t.status === "completed" ? "✔" : t.status === "in_progress" ? "◐" : "□";
        const text = t.status === "in_progress" && t.activeForm ? t.activeForm : t.subject;
        return `${t.id} ${mark} ${oneLine(text, 80)}`;
    });
}

export function replayTodoState(branch: Iterable<unknown>): TodoTask[] | undefined {
    let result: TodoTask[] | undefined;
    for (const entry of branch) {
        const e = entry as { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
        if (e?.type !== "message") continue;
        const msg = e.message;
        if (msg?.role !== "toolResult" || msg.toolName !== "todo") continue;
        const d = msg.details as { tasks?: unknown[]; nextId?: unknown } | undefined;
        if (!d || !Array.isArray(d.tasks) || typeof d.nextId !== "number") continue;
        result = d.tasks.filter(
            (t): t is TodoTask => !!t && typeof (t as TodoTask).id === "number" && typeof (t as TodoTask).subject === "string" && typeof (t as TodoTask).status === "string",
        );
    }
    return result;
}

export function renderTodoTasks(tasks: TodoTask[] | undefined): string {
    if (tasks === undefined) return "No tasks yet";
    const live = tasks.filter((t) => t.status !== "deleted");
    if (live.length === 0) return "No open tasks";
    return taskLines(live).join("\n");
}

/** Single-line `·`-joined variant — toasts only (they can't render line breaks). */
export function renderTodoTasksInline(tasks: TodoTask[] | undefined): string {
    if (tasks === undefined) return "No tasks yet";
    const live = tasks.filter((t) => t.status !== "deleted");
    if (live.length === 0) return "No open tasks";
    return taskLines(live).join(" · ");
}

/**
 * Deliver the task list for a button tap: ≤3 tasks that fit the toast limit →
 * inline toast; anything longer → a message with ONE TASK PER LINE (the
 * single-line `·` rendering gets unreadable fast — README sample notwithstanding).
 */
export function deliverTasks(
    chat: { client: TelegramClient; chatId: string },
    callbackQueryId: string,
    tasks: TodoTask[] | undefined,
): void {
    const live = (tasks ?? []).filter((t) => t.status !== "deleted");
    const inline = renderTodoTasksInline(tasks);
    if (live.length <= 3 && inline.length <= TOAST_MAX) {
        chat.client.answerCallbackQuery(callbackQueryId, inline).catch(() => {});
        return;
    }
    chat.client.answerCallbackQuery(callbackQueryId, "📋 tasks").catch(() => {});
    chat.client.sendMessage(chat.chatId, `<b>📋 tasks</b>\n${escapeHtml(renderTodoTasks(tasks))}`).catch(() => {});
}

// ---------------------------------------------------------------------------
// Run state + rendering
// ---------------------------------------------------------------------------

interface ActivityLine {
    toolCallId: string;
    tool: string;
    summary: string;
    startedAt: number;
    done: boolean;
    error: boolean;
}

export interface RunState {
    messageId: number | undefined;
    startedAt: number;
    segments: number;
    turnCount: number;
    toolCount: number;
    errorCount: number;
    errorPinged: boolean;
    stopped: boolean;
    tokensIn: number;
    tokensOut: number;
    costUsd: number | undefined;
    lastAssistantLine: string | undefined;
    activity: ActivityLine[];
    project: string;
    sessionLabel: string;
    settled: boolean;
    lease?: PollLease;
}

export interface ProgressDeps {
    getChat?: () => { client: TelegramClient; chatId: string } | undefined;
    enabled?: () => boolean;
    host?: string;
    now?: () => number;
    /** Throttle for status-message edits (test knob; default 10s). */
    minEditIntervalMs?: number;
    /** Shared poll hub (default: the process-wide PollHub). */
    pollHub?: PollHub;
    /** Abort the agent run (default: captured ctx.abort(); test seam). */
    abort?: () => void;
    /** Read the session branch for the tasks button (default: ctx.sessionManager.getBranch). */
    getBranch?: () => Iterable<unknown> | undefined;
    /** Instance id embedded in callback nonces (default: hostname:pid). */
    instanceId?: string;
}

export interface RunTracker {
    onAgentStart(ctx: ExtensionContext): void;
    onTurnStart(turnIndex: number): void;
    onToolStart(event: { toolCallId: string; toolName: string; args?: unknown }): void;
    onToolEnd(event: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }): void;
    onMessageEnd(message: unknown): void;
    onAgentSettled(): void;
    onShutdown(reason: string): void;
    /** Dialog pings (M4): notification-only spans for foreign blocking dialogs. */
    onUIPromptStart(kind: string, title?: string): void;
    onUIPromptEnd(): void;
    /** Test/diagnostic access. */
    readonly openRun: RunState | undefined;
}

function renderActivity(run: RunState, now: number): string {
    const all = run.activity;
    if (all.length === 0) return "";
    let lines = all;
    let truncated = false;
    if (all.length > MAX_ACTIVITY_LINES) {
        // Keep head+tail, mark the elided middle (same budget idea as the ask
        // message: never silently drop the latest activity).
        const keepHead = Math.ceil(MAX_ACTIVITY_LINES / 2) - 1; // -1 for the … marker
        const keepTail = Math.floor(MAX_ACTIVITY_LINES / 2);
        lines = [...all.slice(0, keepHead), ...all.slice(all.length - keepTail)];
        truncated = true;
    }
    const rendered = lines.map((l, i) => {
        const prefix = i === lines.length - 1 ? "└──" : "├──";
        const mark = l.error ? "⚠️" : l.done ? "✅" : "⚙️";
        const running = !l.done && !l.error ? ` · ${formatElapsed(now - l.startedAt)}` : "";
        const summary = l.summary ? ` · ${escapeHtml(l.summary)}` : "";
        return `${prefix} ${mark} ${escapeHtml(l.tool)}${summary}${running}`;
    });
    return (truncated ? `${rendered.slice(0, 1).join("")}\n<i>…</i>\n${rendered.slice(1).join("\n")}` : rendered.join("\n"));
}

export function renderRunMessage(run: RunState, now: number): string {
    const head = `🚀 <b>run · ${escapeHtml(run.project)} · ${escapeHtml(run.sessionLabel)}</b>`;
    const activity = renderActivity(run, now);
    const status = run.stopped
        ? `⏹ stopping… turn ${run.turnCount || 1} · ${formatElapsed(now - run.startedAt)}`
        : `⏳ turn ${run.turnCount || 1} · ${formatElapsed(now - run.startedAt)} · ` +
          `↑${formatTokens(run.tokensIn)} ↓${formatTokens(run.tokensOut)} tok`;
    return activity ? `${head}\n${activity}\n\n${status}` : `${head}\n\n${status}`;
}

export function renderSettleSummary(run: RunState, now: number): string {
    const title = run.stopped ? "⏹ stopped" : "✅ done";
    const tools = `${run.toolCount} tools${run.errorCount > 0 ? ` (${run.errorCount} ⚠️)` : ""}`;
    const cost = run.costUsd !== undefined ? ` · $${run.costUsd.toFixed(3)}` : "";
    const head =
        `<b>${title} · ${escapeHtml(run.project)} · ${escapeHtml(run.sessionLabel)}</b>\n` +
        `${run.turnCount} turns · ${tools} · ${formatElapsed(now - run.startedAt)} · ` +
        `↑${formatTokens(run.tokensIn)} ↓${formatTokens(run.tokensOut)} tok${cost}`;
    const last = run.lastAssistantLine ? `\n\n${escapeHtml(oneLine(run.lastAssistantLine, 300))}` : "";
    return head + last;
}

export function renderRunFinal(run: RunState, now: number): string {
    const title = run.stopped ? "⏹ stopped" : "✅ done";
    return `🚀 <b>run · ${escapeHtml(run.project)} · ${escapeHtml(run.sessionLabel)}</b>\n\n<b>${title} · ${formatElapsed(now - run.startedAt)}</b>`;
}

interface AssistantLike {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input?: number; output?: number; cost?: { total?: number } };
}

// ---------------------------------------------------------------------------
// The tracker
// ---------------------------------------------------------------------------

/** Should THIS process relay an unclaimed Telegram text to the controller?
 *  Pure predicate (smoke-tested): slash text always relays (no wizard eats
 *  slash commands); plain text relays ONLY when no ask_user_question is open
 *  here — an open wizard owns plain text (it's an ANSWER, never steering). */
export function shouldRelayUnclaimedText(text: string | undefined, askDepth: number): boolean {
    const t = (text ?? "").trim();
    if (t.length === 0) return false;
    if (t.startsWith("/")) return true;
    return askDepth === 0;
}

export function createRunTracker(deps: ProgressDeps = {}): RunTracker {
    const getChat = deps.getChat ?? coreGetChat;
    const enabled = deps.enabled ?? progressEnabled;
    const host = deps.host ?? hostname();
    const now = deps.now ?? Date.now;
    const minInterval = deps.minEditIntervalMs ?? MIN_EDIT_INTERVAL_MS;
    const hub = deps.pollHub ?? getSharedPollHub();
    const instanceId = deps.instanceId ?? `${host}:${process.pid}`;
    const doAbort = (): void => {
        if (deps.abort) {
            deps.abort();
            return;
        }
        try {
            ctx?.abort();
        } catch {
            /* abort is best-effort */
        }
    };
    const branch = (): Iterable<unknown> | undefined => {
        try {
            return deps.getBranch ? deps.getBranch() : (ctx?.sessionManager.getBranch() as Iterable<unknown> | undefined);
        } catch {
            return undefined;
        }
    };

    let run: RunState | undefined;
    let ctx: ExtensionContext | undefined;
    let lastEditAt = 0;
    let pendingEdit: ReturnType<typeof setTimeout> | undefined;
    let lastErrorNotify = 0;
    /** Serialize edits so a throttled edit can never land after a close edit. */
    let editChain: Promise<void> = Promise.resolve();

    // --- dialog-ping state (M4) ---------------------------------------------
    /** ask_user_question executions in flight — its wizard already messages. */
    let askDepth = 0;
    /** Open ui_prompt span depth (pi coalesces nested prompts; refcount anyway). */
    let promptDepth = 0;
    interface DialogPing {
        messageId: number;
        text: string;
        resolvedAt: number | undefined;
    }
    let dialogPing: DialogPing | undefined;

    const renderDialogPing = (kind: string, title: string | undefined, runLabel: string): string =>
        `🔔 <b>pi is blocked on a dialog</b>\n<code>${escapeHtml(kind)}</code>${title ? ` — ${escapeHtml(oneLine(title, 120))}` : ""}\n${escapeHtml(runLabel)}\nAnswer at the terminal — this dialog can't be answered remotely.`;

    const resolveDialogPing = (finalLine: string): void => {
        const ping = dialogPing;
        if (!ping || ping.resolvedAt !== undefined) return;
        ping.resolvedAt = now();
        const chat = client();
        if (!chat) return;
        editChain = editChain.then(() =>
            chat.client.editMessageText(chat.chatId, ping.messageId, `${ping.text}\n\n<b>${escapeHtml(finalLine)}</b>`).then(() => undefined).catch(() => {}),
        );
    };

    const fail = (err: unknown): void => {
        if (now() - lastErrorNotify < ERROR_NOTIFY_INTERVAL_MS) return;
        lastErrorNotify = now();
        const message = err instanceof Error ? err.message : String(err);
        ctx?.ui.notify(`telegram progress failed: ${message}`, "error");
    };

    const client = (): { client: TelegramClient; chatId: string } | undefined => {
        try {
            return getChat();
        } catch {
            return undefined;
        }
    };
    const clientChatId = (): string | undefined => {
        try {
            return client()?.chatId;
        } catch {
            return undefined;
        }
    };

    const editNow = (): void => {
        const r = run;
        if (!r || r.messageId === undefined || r.settled) return;
        lastEditAt = now();
        const chat = client();
        if (!chat) return;
        const text = renderRunMessage(r, now());
        // Edits MUST carry the keyboard — an editMessageText without
        // reply_markup strips the buttons (same lesson as the ask wizard).
        const markup = { inline_keyboard: buildRunKeyboard(instanceId) };
        editChain = editChain.then(() =>
            chat.client.editMessageText(chat.chatId, r.messageId as number, text, markup).then(() => undefined).catch(() => {}),
        );
    };

    const scheduleEdit = (immediate = false): void => {
        const r = run;
        if (!r || r.messageId === undefined || r.settled) return;
        const since = now() - lastEditAt;
        if (immediate || since >= minInterval) {
            if (pendingEdit) {
                clearTimeout(pendingEdit);
                pendingEdit = undefined;
            }
            editNow();
            return;
        }
        // Trailing edge: whatever changed always lands within one interval.
        if (!pendingEdit) {
            pendingEdit = setTimeout(() => {
                pendingEdit = undefined;
                editNow();
            }, minInterval - since);
            pendingEdit.unref?.();
        }
    };

    const closeRun = (finalText: (r: RunState) => string): void => {
        const r = run;
        if (!r) return;
        r.settled = true;
        if (pendingEdit) {
            clearTimeout(pendingEdit);
            pendingEdit = undefined;
        }
        r.lease?.release();
        r.lease = undefined;
        const chat = client();
        if (chat && r.messageId !== undefined) {
            const text = finalText(r);
            editChain = editChain.then(() =>
                chat.client.editMessageText(chat.chatId, r.messageId as number, text).then(() => undefined).catch(() => {}),
            );
        }
        run = undefined;
        ctx = undefined;
    };

    // --- button actions (M3) ------------------------------------------------

    const handleAction = (action: string, cb: NonNullable<TelegramUpdate["callback_query"]>): void => {
        const chat = client();
        if (!chat) return;
        const ack = (text?: string) => chat.client.answerCallbackQuery(cb.id, text).catch(() => {});
        switch (action) {
            case "stop": {
                const r = run;
                if (!r || r.settled) return void ack("no active run");
                r.stopped = true;
                doAbort();
                ack("⏹ stop requested");
                scheduleEdit(true);
                return;
            }
            case "refresh": {
                if (!run || run.settled) return void ack("no active run");
                editNow(); // bypass the throttle once
                ack("refreshed");
                return;
            }
            case "tasks": {
                deliverTasks(chat, cb.id, replayTodoState(branch() ?? []));
                return;
            }
            default:
                ack("expired");
        }
    };


    /** Claim-routed update handler: p:-prefixed callbacks are always ours to
     *  consume (own → act, foreign → toast naming the owner); everything else
     *  (wizard nonces, messages) passes through. Unclaimed TEXT relays to the
     *  controller — this poll already advanced Telegram's offset, so dropping
     *  it would silently lose the message (verified live during the phone test). */
    const handleUpdate = (u: TelegramUpdate): boolean => {
        const cb = u.callback_query;
        if (!cb) {
            const text = u.message?.text;
            if (shouldRelayUnclaimedText(text, askDepth) && String(u.message?.chat?.id ?? "") === clientChatId()) {
                void relayToController(text as string).catch(() => {});
            }
            return false;
        }
        const data = cb.data ?? "";
        if (!data.startsWith(PROGRESS_NONCE_PREFIX)) return false;
        const chat = client();
        if (!chat) return true; // configured chat vanished: swallow, nothing to say
        if (String(cb.message?.chat?.id ?? "") !== chat.chatId) return false; // foreign chat → unclaimed path
        const rest = data.slice(PROGRESS_NONCE_PREFIX.length); // `${instanceId}:${action}`
        if (rest.startsWith(`${instanceId}:`)) {
            handleAction(rest.slice(instanceId.length + 1), cb);
        } else {
            // Another pi process's button landed on our poll — say who owns it.
            const foreign = rest.split(":")[0];
            chat.client.answerCallbackQuery(cb.id, `owned by ${foreign} — try again shortly`).catch(() => {});
        }
        return true;
    };

    return {
        get openRun() {
            return run;
        },
        onAgentStart(c): void {
            try {
                ctx = c;
                if (run) {
                    // Retry / auto-compaction continuation of the same logical run.
                    run.segments += 1;
                    return;
                }
                if (!enabled()) return;
                const chat = client();
                if (!chat) return;
                const r: RunState = {
                    messageId: undefined,
                    startedAt: now(),
                    segments: 1,
                    turnCount: 0,
                    toolCount: 0,
                    errorCount: 0,
                    errorPinged: false,
                    stopped: false,
                    tokensIn: 0,
                    tokensOut: 0,
                    costUsd: undefined,
                    lastAssistantLine: undefined,
                    activity: [],
                    project: basename(c.cwd),
                    sessionLabel: c.sessionManager.getSessionName() ?? host,
                    settled: false,
                };
                run = r;
                // Silent open: progress updates must not buzz; only settle/error do.
                // The keyboard (stop/tasks/refresh) rides along from the start.
                chat.client
                    .sendMessage(
                        chat.chatId,
                        renderRunMessage(r, now()),
                        { inline_keyboard: buildRunKeyboard(instanceId) },
                        { disableNotification: true },
                    )
                    .then(({ message_id }) => {
                        if (run !== r || r.settled) return; // closed while in flight
                        r.messageId = message_id;
                        lastEditAt = now();
                        // Buttons need inbound updates — join the shared poll hub.
                        r.lease = hub.subscribe(handleUpdate);
                        scheduleEdit();
                    })
                    .catch(fail);
            } catch (err) {
                fail(err);
            }
        },
        onTurnStart(turnIndex): void {
            try {
                if (!run) return;
                run.turnCount = Math.max(run.turnCount, turnIndex + 1);
                scheduleEdit();
            } catch (err) {
                fail(err);
            }
        },
        onToolStart(event): void {
            try {
                if (event.toolName === "ask_user_question") askDepth += 1; // wizard messages on its own
                if (!run) return;
                run.toolCount += 1;
                run.activity.push({
                    toolCallId: event.toolCallId,
                    tool: event.toolName,
                    summary: summarizeToolCall(event.toolName, event.args),
                    startedAt: now(),
                    done: false,
                    error: false,
                });
                scheduleEdit();
            } catch (err) {
                fail(err);
            }
        },
        onToolEnd(event): void {
            try {
                if (event.toolName === "ask_user_question" && askDepth > 0) askDepth -= 1;
                if (!run) return;
                const line = run.activity.find((l) => l.toolCallId === event.toolCallId);
                if (line) {
                    line.done = !event.isError;
                    line.error = event.isError === true;
                }
                if (event.isError) {
                    run.errorCount += 1;
                    if (!run.errorPinged) {
                        run.errorPinged = true;
                        const chat = client();
                        if (chat) {
                            // Audible mid-run error ping (once per run).
                            const detail = oneLine(`${event.toolName} failed (turn ${run.turnCount || 1}) — continuing`, 200);
                            chat.client.sendMessage(chat.chatId, `⚠️ <b>${escapeHtml(detail)}</b>`).catch(fail);
                        }
                    }
                    scheduleEdit(true); // errors are worth an immediate edit
                    return;
                }
                scheduleEdit();
            } catch (err) {
                fail(err);
            }
        },
        onMessageEnd(message): void {
            try {
                if (!run) return;
                const m = message as AssistantLike;
                if (m?.role !== "assistant") return;
                const usage = m.usage;
                if (usage) {
                    run.tokensIn += usage.input ?? 0;
                    run.tokensOut += usage.output ?? 0;
                    if (typeof usage.cost?.total === "number") {
                        run.costUsd = (run.costUsd ?? 0) + usage.cost.total;
                    }
                }
                const textBlock = Array.isArray(m.content) ? m.content.find((b) => b?.type === "text" && typeof b.text === "string") : undefined;
                if (textBlock) run.lastAssistantLine = oneLine(textBlock.text as string, 300);
            } catch (err) {
                fail(err);
            }
        },
        onAgentSettled(): void {
            try {
                const r = run;
                if (!r) return;
                resolveDialogPing("run ended");
                const chat = client();
                // Audible settle summary (new message — edits never notify).
                if (chat) {
                    chat.client.sendMessage(chat.chatId, renderSettleSummary(r, now())).catch(fail);
                }
                closeRun((x) => renderRunFinal(x, now()));
            } catch (err) {
                fail(err);
            }
        },
        onShutdown(reason): void {
            try {
                resolveDialogPing("turn ended");
                closeRun((x) => `🚀 <b>run · ${escapeHtml(x.project)} · ${escapeHtml(x.sessionLabel)}</b>\n\n⚪ ${escapeHtml(reason)}`);
            } catch (err) {
                fail(err);
            }
        },
        onUIPromptStart(kind, title): void {
            try {
                promptDepth += 1;
                if (promptDepth > 1) return; // nested span — pi coalesces, we refcount
                if (askDepth > 0) return; // the ask wizard already messages
                const r = run;
                if (!r || r.settled) return; // walk-away heuristic: only mid-run dialogs ping
                const chat = client();
                if (!chat) return;
                const text = renderDialogPing(kind, title, `${r.project} · ${r.sessionLabel}`);
                const reuse = dialogPing !== undefined && dialogPing.resolvedAt !== undefined && now() - dialogPing.resolvedAt < PING_REOPEN_MS;
                if (reuse && dialogPing) {
                    const ping = dialogPing;
                    chat.client
                        .editMessageText(chat.chatId, ping.messageId, text)
                        .then(() => {
                            ping.text = text;
                            ping.resolvedAt = undefined;
                        })
                        .catch(() => {
                            dialogPing = undefined; // message gone — next ping sends anew
                        });
                } else {
                    chat.client
                        .sendMessage(chat.chatId, text) // AUDIBLE: blocking = attention
                        .then(({ message_id }) => {
                            dialogPing = { messageId: message_id, text, resolvedAt: undefined };
                        })
                        .catch(fail);
                }
            } catch (err) {
                fail(err);
            }
        },
        onUIPromptEnd(): void {
            try {
                if (promptDepth > 0) promptDepth -= 1;
                if (promptDepth > 0) return;
                resolveDialogPing("✅ resolved");
            } catch (err) {
                fail(err);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    const tracker = createRunTracker();

    const safe = (fn: () => void): void => {
        try {
            fn();
        } catch {
            /* progress must never disturb the session */
        }
    };

    pi.on("agent_start", (_event, ctx) => safe(() => tracker.onAgentStart(ctx)));
    pi.on("turn_start", (event) => safe(() => tracker.onTurnStart(event.turnIndex)));
    pi.on("tool_execution_start", (event) => safe(() => tracker.onToolStart(event)));
    pi.on("tool_execution_end", (event) => safe(() => tracker.onToolEnd(event)));
    pi.on("message_end", (event) => safe(() => tracker.onMessageEnd(event.message)));
    pi.on("agent_settled", () => safe(() => tracker.onAgentSettled()));
    pi.on("session_shutdown", () => safe(() => tracker.onShutdown("session ended")));
    pi.on("ui_prompt_start", (event) => safe(() => tracker.onUIPromptStart(event.kind, event.title)));
    pi.on("ui_prompt_end", () => safe(() => tracker.onUIPromptEnd()));

    pi.registerCommand("progress", {
        description: "Telegram progress tracking: status, on/off",
        handler: async (args: string, ctx) => {
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
            switch (sub) {
                case "on":
                case "off": {
                    const { config, source } = loadConfig();
                    if (!config) {
                        ctx.ui.notify("No Telegram config — run /telegram setup first.", "error");
                        return;
                    }
                    if (source === "env") {
                        ctx.ui.notify("Config comes from env vars — /progress on|off only works with a config file.", "error");
                        return;
                    }
                    writeConfigFile({ ...config, progress: sub === "on" });
                    ctx.ui.notify(
                        sub === "on"
                            ? "Progress tracking enabled — the next agent run pushes a live status message to Telegram."
                            : "Progress tracking disabled — agent runs stay silent on Telegram (questions still reach you).",
                        "info",
                    );
                    return;
                }
                case "test": {
                    const chat = coreGetChat();
                    if (!chat) {
                        ctx.ui.notify("Telegram not configured/enabled — run /telegram setup.", "error");
                        return;
                    }
                    const instanceId = `${hostname()}:${process.pid}`;
                    const startedAt = Date.now();
                    const sample: RunState = {
                        messageId: undefined,
                        startedAt,
                        segments: 1,
                        turnCount: 2,
                        toolCount: 3,
                        errorCount: 0,
                        errorPinged: true,
                        stopped: false,
                        tokensIn: 1234,
                        tokensOut: 567,
                        costUsd: undefined,
                        lastAssistantLine: undefined,
                        activity: [
                            { toolCallId: "s1", tool: "bash", summary: "npm run typecheck", startedAt: startedAt - 30_000, done: true, error: false },
                            { toolCallId: "s2", tool: "edit", summary: "herdr-telegram-progress.ts", startedAt: startedAt - 10_000, done: false, error: false },
                        ],
                        project: basename(ctx.cwd),
                        sessionLabel: ctx.sessionManager.getSessionName() ?? hostname(),
                        settled: false,
                    };
                    const markup = { inline_keyboard: buildRunKeyboard(instanceId) };
                    let messageId: number | undefined;
                    let closed = false;
                    const lease = getSharedPollHub().subscribe((u) => {
                        const cb = u.callback_query;
                        if (!cb || !(cb.data ?? "").startsWith(PROGRESS_NONCE_PREFIX)) return false;
                        if (String(cb.message?.chat?.id ?? "") !== chat.chatId) return false;
                        const rest = (cb.data as string).slice(PROGRESS_NONCE_PREFIX.length);
                        const ack = (t?: string) => chat.client.answerCallbackQuery(cb.id, t).catch(() => {});
                        if (rest.startsWith(`${instanceId}:`)) {
                            const action = rest.slice(instanceId.length + 1);
                            if (action === "refresh" && messageId !== undefined) {
                                chat.client.editMessageText(chat.chatId, messageId, renderRunMessage(sample, Date.now()), markup).catch(() => {});
                                ack("refreshed");
                            } else if (action === "tasks") {
                                let branch: Iterable<unknown> = [];
                                try {
                                    branch = (ctx.sessionManager.getBranch() as Iterable<unknown>) ?? [];
                                } catch {
                                    /* leave empty */
                                }
                                deliverTasks(chat, cb.id, replayTodoState(branch));
                            } else if (action === "stop") {
                                ack("test window — nothing to stop");
                            } else {
                                ack("expired");
                            }
                        } else {
                            ack(`owned by ${rest.split(":")[0]} — try again shortly`);
                        }
                        return true;
                    });
                    const close = (): void => {
                        if (closed) return;
                        closed = true;
                        lease.release();
                        if (messageId !== undefined) {
                            chat.client
                                .editMessageText(chat.chatId, messageId, `${renderRunFinal(sample, Date.now())}\n\n<i>(test)</i>`)
                                .catch(() => {});
                        }
                    };
                    const timer = setTimeout(close, 60_000);
                    timer.unref?.();
                    chat.client
                        .sendMessage(chat.chatId, renderRunMessage(sample, Date.now()), markup, { disableNotification: true })
                        .then(({ message_id }) => {
                            messageId = message_id;
                            if (closed) close();
                        })
                        .catch((err: unknown) => {
                            closed = true;
                            lease.release();
                            ctx.ui.notify(`telegram test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                        });
                    ctx.ui.notify("Test run message sent with live buttons (60s) — tap them in Telegram.", "info");
                    return;
                }
                default: {
                    // status (also the no-arg help)
                    const hub = getSharedPollHub();
                    const { config, source, split } = loadConfig();
                    const on = progressEnabled();
                    const r = tracker.openRun;
                    const lines = [
                        `progress: ${on ? "enabled" : "disabled"}${process.env.TELEGRAM_PROGRESS === "0" ? " (TELEGRAM_PROGRESS=0 forces off)" : ""}${!config && !split ? " (no config)" : config?.progress === false ? " (config.progress=false)" : ""}`,
                        `config: ${source}${split ? " (partial env config)" : ""} · enabled: ${config?.enabled ?? false}`,
                        `run: ${r ? `open — turn ${r.turnCount || 1} · ${r.activity.length} recent tool(s)` : "idle"}`,
                        `buttons: [📋 tasks] [⏹ stop] [🔁 refresh] · instance ${hostname()}:${process.pid}`,
                        `poll hub: ${hub.subscriberCount} subscriber(s) · ${hub.polling ? "polling" : "idle"}`,
                    ];
                    ctx.ui.notify(lines.join("\n"), "info");
                    return;
                }
            }
        },
    });
}
