/**
 * herdr-telegram-ask — Telegram companion for pi's `ask_user_question`.
 *
 * M1 (this file, notify layer): while pi has an `ask_user_question` open, send a
 * rich Telegram message (questions, options, session context) and edit it to ✅
 * (with the answer) when the question resolves. Two-way answering (same-name
 * tool shadow, buttons, races) is M2 — see jreb-memory plans/herdr-telegram-ask.md.
 *
 * Gating: inert unless pi runs under Herdr (`HERDR_ENV=1`), exactly like the
 * sibling `herdr-blocked-on-question.ts`. Within that, `/telegram setup` creates
 * the config; the notifier only fires when config exists and is enabled.
 *
 * Zero runtime dependencies: Node's global fetch only, and every network path is
 * funneled through an injectable Transport so scripts/smoke-telegram.mts can run
 * the whole thing without touching the network.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramConfig {
    botToken: string;
    chatId: string;
    enabled: boolean;
}

const CONFIG_DIR = join(process.env.HOME ?? "~", ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "herdr-telegram.json");
/** Telegram messages must stay under 4096 chars; leave headroom for the ✅ edit. */
const MAX_MESSAGE_CHARS = 3800;

export function readConfigFile(path: string = CONFIG_PATH): TelegramConfig | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TelegramConfig>;
        if (typeof raw.botToken !== "string" || raw.botToken.length === 0) return undefined;
        if (typeof raw.chatId !== "string" || raw.chatId.length === 0) return undefined;
        return { botToken: raw.botToken, chatId: raw.chatId, enabled: raw.enabled !== false };
    } catch {
        return undefined;
    }
}

export function writeConfigFile(config: TelegramConfig, path: string = CONFIG_PATH): void {
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    // writeFileSync mode only applies at creation; enforce on every save.
    chmodSync(path, 0o600);
}

/** Precedence: env overrides file; `source` tells status/setup where each field came from. */
export function loadConfig(
    env: Record<string, string | undefined> = process.env,
    path: string = CONFIG_PATH,
): { config: TelegramConfig | undefined; source: "env" | "file" | "none"; split: boolean } {
    const file = readConfigFile(path);
    const envToken = env.TELEGRAM_BOT_TOKEN?.trim();
    const envChat = env.TELEGRAM_CHAT_ID?.trim();
    if (envToken && envChat) {
        return { config: { botToken: envToken, chatId: envChat, enabled: file?.enabled ?? true }, source: "env", split: false };
    }
    if (envToken || envChat) {
        // Partial env config is never usable — say so rather than half-work.
        return { config: undefined, source: "none", split: true };
    }
    return { config: file, source: file ? "file" : "none", split: false };
}

// ---------------------------------------------------------------------------
// Telegram client (Bot API subset, injectable transport)
// ---------------------------------------------------------------------------

/** Minimal transport so tests can stub all network I/O. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

let defaultTransport: Transport = globalThis.fetch.bind(globalThis);

/** Test seam: swap the default transport so smoke tests never touch the network. */
export function __setDefaultTransportForTests(transport: Transport | undefined): void {
    defaultTransport = transport ?? globalThis.fetch.bind(globalThis);
}

export class TelegramApiError extends Error {
    public readonly method: string;
    public readonly description: string;
    constructor(method: string, description: string) {
        super(`Telegram ${method} failed: ${description}`);
        this.name = "TelegramApiError";
        this.method = method;
        this.description = description;
    }
}

interface TelegramResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
}

export interface TelegramClient {
    getMe(): Promise<{ id: number; username: string }>;
    sendMessage(chatId: string, text: string): Promise<{ message_id: number }>;
    editMessageText(chatId: string, messageId: number, text: string): Promise<boolean>;
    getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
}

export interface TelegramUpdate {
    update_id: number;
    message?: { chat: { id: number; type: string }; text?: string };
}

export function createTelegramClient(botToken: string, transport: Transport = defaultTransport): TelegramClient {
    const call = async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
        const init: RequestInit = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params),
            signal: signal ?? AbortSignal.timeout(15_000),
        };
        const res = await transport(`https://api.telegram.org/bot${botToken}/${method}`, init);
        const data = (await res.json()) as TelegramResponse<T>;
        if (!data.ok) throw new TelegramApiError(method, data.description ?? `HTTP ${res.status}`);
        return data.result as T;
    };
    return {
        getMe: () => call("getMe", {}),
        sendMessage: (chatId, text) =>
            call("sendMessage", {
                chat_id: chatId,
                text,
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
            }),
        editMessageText: (chatId, messageId, text) =>
            call<{ boolean: boolean }>("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: "HTML",
            }).then(() => true),
        getUpdates: (offset, timeoutSec, signal) =>
            call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message"] }, signal),
    };
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export interface QuestionnaireArgs {
    questions?: Array<{
        question?: string;
        header?: string;
        multiSelect?: boolean;
        options?: Array<{ label?: string; description?: string; preview?: string }>;
    }>;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** The ✅-edit summary: first text block of the tool result (rpiv's answer envelope). */
export function resolveAnswerSummary(result: unknown): string | undefined {
    const content = (result as { content?: Array<{ type?: string; text?: unknown }> } | undefined)?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    if (typeof text !== "string" || text.length === 0) return undefined;
    return oneLine(text, 180);
}

export interface RenderInput {
    args: QuestionnaireArgs;
    host: string;
    project: string;
    sessionName?: string;
    now?: Date;
}

export function renderQuestionnaireMessage(input: RenderInput): string {
    const now = input.now ?? new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const questions = Array.isArray(input.args.questions) ? input.args.questions : [];

    const head =
        `🟡 <b>pi needs your input</b>\n` +
        `host:${escapeHtml(input.host)} · proj:${escapeHtml(input.project)}` +
        (input.sessionName ? ` · session:${escapeHtml(input.sessionName)}` : "") +
        ` · since ${time}`;

    const body: string[] = [];
    let truncated = false;
    let hasPreview = false;

    questions.forEach((q, i) => {
        const label = oneLine(typeof q.question === "string" ? q.question : `Question ${i + 1}`, 160);
        const mode = q.multiSelect ? "pick any" : "pick one";
        body.push(`\n<b>[${i + 1}/${questions.length}] ${escapeHtml(label)}</b> <i>(${mode})</i>`);
        const options = Array.isArray(q.options) ? q.options : [];
        options.forEach((o, j) => {
            if (typeof o.preview === "string" && o.preview.length > 0) hasPreview = true;
            const optLabel = escapeHtml(oneLine(typeof o.label === "string" ? o.label : `option ${j + 1}`, 80));
            const desc = typeof o.description === "string" && o.description.trim() ? ` — ${escapeHtml(oneLine(o.description, 160))}` : "";
            body.push(`${j + 1}. <b>${optLabel}</b>${desc}`);
        });
        if (options.length === 0) body.push("<i>(no options — custom answer)</i>");
    });

    if (questions.length === 0) body.push("\n<i>(questionnaire could not be parsed — see terminal)</i>");

    // Budget: truncate question bodies from the middle if over the Telegram limit.
    const tail = `\n${hasPreview ? "<i>(option previews not shown here)</i>\n" : ""}Answer at the terminal for now — remote answering arrives with v2.`;
    while (head.length + body.join("\n").length + tail.length > MAX_MESSAGE_CHARS && body.length > 1) {
        const mid = Math.floor(body.length / 2);
        body.splice(mid, 1);
        truncated = true;
    }
    if (truncated) body.push("\n<b>… (truncated — full questionnaire at the terminal)</b>");

    return head + body.join("\n") + tail;
}

// ---------------------------------------------------------------------------
// Notifier (Layer N)
// ---------------------------------------------------------------------------

export interface NotifierDeps {
    client: TelegramClient;
    chatId: string;
    /** ctx.ui.notify stand-in; used for contained error surfacing. */
    notify: (message: string, level: "info" | "error") => void;
    host?: string;
}

interface OpenQuestion {
    messageId: number;
    startedAt: number;
    text: string;
}

const ERROR_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

export function createNotifier(deps: NotifierDeps) {
    const open = new Map<string, OpenQuestion>();
    /** toolCallIds whose send is still in flight; if they end first, edit on landing. */
    const pendingEnds = new Map<string, { summary?: string; isError: boolean; startedAt: number }>();
    let lastErrorNotify = 0;

    /** Surface at most one Telegram failure notice per interval; never throw to pi. */
    const fail = (err: unknown) => {
        if (Date.now() - lastErrorNotify < ERROR_NOTIFY_INTERVAL_MS) return;
        lastErrorNotify = Date.now();
        const message = err instanceof Error ? err.message : String(err);
        deps.notify(`telegram notify failed: ${message}`, "error");
    };

    const waited = (startedAt: number): string => {
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    };

    const editResolved = (messageId: number, text: string, startedAt: number, summary: string | undefined, isError: boolean): void => {
        const resolved = isError ? `⚠️ closed with error (waited ${waited(startedAt)})` : `✅ resolved (waited ${waited(startedAt)})`;
        const edit = summary ? `${text}\n\n<b>${resolved}</b>\n${escapeHtml(summary)}` : `${text}\n\n<b>${resolved}</b>`;
        deps.client.editMessageText(deps.chatId, messageId, edit).catch(() => {
            /* message may be deleted/unchanged; nothing to recover */
        });
    };

    return {
        onToolStart(event: { toolCallId: string; toolName: string; args?: unknown }, ctx: ExtensionContext): void {
            if (event.toolName !== "ask_user_question" || open.has(event.toolCallId)) return;
            const startedAt = Date.now();
            const text = renderQuestionnaireMessage({
                args: (event.args ?? {}) as QuestionnaireArgs,
                host: deps.host ?? hostname(),
                project: basename(ctx.cwd),
                sessionName: ctx.sessionManager.getSessionName() ?? undefined,
            });
            deps.client
                .sendMessage(deps.chatId, text)
                .then(({ message_id }) => {
                    const earlyEnd = pendingEnds.get(event.toolCallId);
                    if (earlyEnd) {
                        // Question already ended before the send landed — resolve immediately.
                        pendingEnds.delete(event.toolCallId);
                        editResolved(message_id, text, earlyEnd.startedAt, earlyEnd.summary, earlyEnd.isError);
                        return;
                    }
                    open.set(event.toolCallId, { messageId: message_id, startedAt, text });
                })
                .catch(fail);
        },

        onToolEnd(event: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }): void {
            if (event.toolName !== "ask_user_question") return;
            const summary = resolveAnswerSummary(event.result);
            const isError = event.isError === true;
            const q = open.get(event.toolCallId);
            if (!q) {
                // Send still in flight — remember and let the landing send resolve it.
                if (pendingEnds.size < 16) {
                    pendingEnds.set(event.toolCallId, { summary, isError, startedAt: Date.now() });
                }
                return;
            }
            open.delete(event.toolCallId);
            editResolved(q.messageId, q.text, q.startedAt, summary, isError);
        },

        /** Safety net: agent turn ended while a question was still open (abort, crash). */
        drain(): void {
            for (const [id, q] of open) {
                open.delete(id);
                pendingEnds.delete(id);
                deps.client
                    .editMessageText(deps.chatId, q.messageId, `${q.text}\n\n⚪ closed without an answer (turn ended) — waited ${waited(q.startedAt)}`)
                    .catch(() => {});
            }
        },

        get openCount(): number {
            return open.size;
        },
    };
}

export type Notifier = ReturnType<typeof createNotifier>;

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const SAMPLE_ARGS: QuestionnaireArgs = {
    questions: [
        {
            question: "Which library should we use for date formatting?",
            header: "Library",
            options: [
                { label: "date-fns", description: "Functional, tree-shakeable" },
                { label: "Luxon", description: "Immutable, timezone-first" },
            ],
        },
        {
            question: "Which checks should run?",
            header: "Checks",
            multiSelect: true,
            options: [
                { label: "typecheck", description: "tsc --noEmit" },
                { label: "smoke", description: "stub-render tests" },
            ],
        },
    ],
};

export default function (pi: ExtensionAPI) {
    if (process.env.HERDR_ENV !== "1") {
        return;
    }

    let notifier: Notifier | undefined;

    const activate = (): void => {
        const { config } = loadConfig();
        if (!config || !config.enabled) {
            notifier = undefined;
            return;
        }
        notifier = createNotifier({
            client: createTelegramClient(config.botToken),
            chatId: config.chatId,
            notify: (message, level) => {
                // ctx is not in scope here; pi.ui.notify is not part of the API, so
                // route through the last known event ctx (set by ensureNotifier below).
                lastNotify?.(message, level);
            },
        });
    };

    let lastNotify: ((message: string, level: "info" | "error") => void) | undefined;

    const ensureNotifier = (ctx: ExtensionContext): void => {
        lastNotify ??= (message, level) => ctx.ui.notify(message, level);
        // Re-activate whenever absent: first use, or after /telegram on|off reset it.
        if (!notifier) activate();
    };

    pi.on("tool_execution_start", (event, ctx) => {
        ensureNotifier(ctx);
        notifier?.onToolStart(event, ctx);
    });
    pi.on("tool_execution_end", (event) => {
        notifier?.onToolEnd(event);
    });
    pi.on("agent_end", () => {
        notifier?.drain();
    });
    pi.on("session_shutdown", () => {
        notifier?.drain();
    });

    pi.registerCommand("telegram", {
        description: "Herdr Telegram bridge: setup, status, on/off, test",
        handler: async (args: string, ctx) => {
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
            switch (sub) {
                case "setup":
                    await runSetup(ctx);
                    return;
                case "on":
                case "off": {
                    const { config, source } = loadConfig();
                    if (!config) {
                        ctx.ui.notify("No config — run /telegram setup first.", "error");
                        return;
                    }
                    if (source === "env") {
                        ctx.ui.notify("Config comes from env vars — /telegram on|off only works with a config file.", "error");
                        return;
                    }
                    writeConfigFile({ ...config, enabled: sub === "on" });
                    notifier = undefined; // re-activate lazily with fresh config
                    ctx.ui.notify(`Telegram notifications ${sub === "on" ? "enabled" : "disabled"}.`, "info");
                    return;
                }
                case "test": {
                    const { config } = loadConfig();
                    if (!config || !config.enabled) {
                        ctx.ui.notify("Telegram not configured/enabled — run /telegram setup.", "error");
                        return;
                    }
                    const client = createTelegramClient(config.botToken);
                    try {
                        const text = renderQuestionnaireMessage({
                            args: SAMPLE_ARGS,
                            host: hostname(),
                            project: basename(ctx.cwd),
                            sessionName: ctx.sessionManager.getSessionName() ?? undefined,
                        });
                        const { message_id } = await client.sendMessage(config.chatId, text);
                        await new Promise((r) => setTimeout(r, 1500));
                        await client.editMessageText(
                            config.chatId,
                            message_id,
                            `${text}\n\n<b>✅ resolved (test)</b>`,
                        );
                        ctx.ui.notify("Test message sent and edited — check Telegram.", "info");
                    } catch (err) {
                        ctx.ui.notify(`telegram test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                    }
                    return;
                }
                default: {
                    // status (also the no-arg help)
                    const { config, source, split } = loadConfig();
                    const lines = [
                        `herdr: ${process.env.HERDR_ENV === "1" ? "yes" : "no (extension inert)"}`,
                        `config: ${source}${split ? " (partial env config: set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)" : ""}`,
                        `token: ${config ? "set" : "missing"} · chat: ${config?.chatId ? "set" : "missing"} · enabled: ${config?.enabled ?? false}`,
                        `file: ${CONFIG_PATH}`,
                    ];
                    ctx.ui.notify(lines.join("\n"), "info");
                    return;
                }
            }
        },
    });
}

// ---------------------------------------------------------------------------
// /telegram setup
// ---------------------------------------------------------------------------

async function runSetup(ctx: ExtensionContext): Promise<void> {
    const existing = readConfigFile();

    const tokenInput = (await ctx.ui.input(
        `Bot token from @BotFather${existing ? " (empty = keep current)" : ""}`,
    ))?.trim();
    if (tokenInput === undefined) return; // cancelled
    const botToken = tokenInput || existing?.botToken;
    if (!botToken) {
        ctx.ui.notify("Setup aborted — no token.", "error");
        return;
    }

    let me: { id: number; username: string };
    try {
        me = await createTelegramClient(botToken).getMe();
    } catch (err) {
        ctx.ui.notify(`Token check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
    }

    ctx.ui.notify(`Token OK (@${me.username}). Now send /start to @${me.username} in Telegram — waiting 90s…`, "info");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    try {
        const client = createTelegramClient(botToken);
        let offset = 0;
        const deadline = Date.now() + 90_000;
        let chatId: string | undefined;
        while (chatId === undefined && Date.now() < deadline) {
            const updates = await client.getUpdates(offset, 25, ac.signal).catch((err: unknown) => {
                if (ac.signal.aborted) return [];
                throw err;
            });
            for (const u of updates) {
                offset = u.update_id + 1;
                const chat = u.message?.chat;
                if (u.message?.text?.trim() === "/start" && chat?.type === "private") {
                    chatId = String(chat.id);
                    break;
                }
            }
        }
        if (!chatId) {
            ctx.ui.notify("No /start received in 90s — setup aborted, nothing saved.", "error");
            return;
        }
        await client.sendMessage(chatId, "✅ herdr-telegram-ask connected — pi will message you here when it needs input.");
        writeConfigFile({ botToken, chatId, enabled: true });
        ctx.ui.notify(`Saved ${CONFIG_PATH} (0600). Notifications are ON — /telegram test to verify.`, "info");
    } catch (err) {
        ctx.ui.notify(`Setup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
        clearTimeout(timer);
    }
}
