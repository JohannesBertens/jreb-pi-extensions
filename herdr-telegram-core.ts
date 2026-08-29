/**
 * herdr-telegram-core — shared plumbing for the herdr-telegram-* extensions.
 *
 * NOT an extension: the default export is a deliberate no-op so pi's
 * auto-discovery of ~/.pi/agent/extensions/*.ts loads this file without side
 * effects. The real content is the named exports used by
 * `herdr-telegram-ask.ts` and `herdr-telegram-progress.ts`:
 *
 *   - TelegramClient (Bot API subset over an injectable transport)
 *   - config (~/.pi/agent/herdr-telegram.json, 0600; env overrides)
 *   - PollHub — ONE getUpdates long-poll loop per process, shared by every
 *     subscriber (ask wizard windows, progress run buttons)
 *
 * Singleton caveat (M0 spike `scripts/spike-jiti-singleton.mts`): pi creates a
 * FRESH jiti instance with `moduleCache: false` for every extension file, so
 * each importer of this module gets its own module state. Anything that must
 * be process-wide (the PollHub, the test transport seam) therefore lives on
 * `globalThis` behind `Symbol.for` keys — the standard duplicated-module
 * dedupe pattern. Never replace those with module-level variables.
 *
 * Zero runtime dependencies: Node's global fetch only.
 */

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Test transport seam (process-wide — see header)
// ---------------------------------------------------------------------------

/** Minimal transport so tests can stub all network I/O. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

const TRANSPORT_KEY = Symbol.for("herdr-telegram.transport");
type TransportGlobal = typeof globalThis & { [TRANSPORT_KEY]?: Transport };
const transportGlobal = globalThis as TransportGlobal;

/** Test seam: swap the transport for ALL core consumers; undefined restores fetch. */
export function __setDefaultTransportForTests(transport: Transport | undefined): void {
    transportGlobal[TRANSPORT_KEY] = transport;
}

function currentTransport(): Transport {
    return transportGlobal[TRANSPORT_KEY] ?? globalThis.fetch.bind(globalThis);
}

// ---------------------------------------------------------------------------
// Telegram client (Bot API subset, injectable transport)
// ---------------------------------------------------------------------------

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
    sendMessage(chatId: string, text: string, replyMarkup?: unknown, opts?: SendMessageOpts): Promise<{ message_id: number }>;
    editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: unknown): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
}

export interface SendMessageOpts {
    /** true = silent delivery (no sound/banner) — for chatty progress updates. */
    disableNotification?: boolean;
}

export interface TelegramUpdate {
    update_id: number;
    message?: { chat: { id: number; type: string }; text?: string; message_id?: number };
    callback_query?: {
        id: string;
        data?: string;
        message?: { chat: { id: number; type: string }; message_id: number };
    };
}

export function createTelegramClient(botToken: string, transport: Transport = currentTransport()): TelegramClient {
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
        sendMessage: (chatId, text, replyMarkup, opts) =>
            call("sendMessage", {
                chat_id: chatId,
                text,
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
                ...(opts?.disableNotification ? { disable_notification: true } : {}),
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
        editMessageText: (chatId, messageId, text, replyMarkup) =>
            call<{ boolean: boolean }>("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: "HTML",
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }).then(() => true),
        answerCallbackQuery: (callbackQueryId, text) =>
            call<{ boolean: boolean }>("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                ...(text ? { text } : {}),
            }).then(() => true),
        getUpdates: (offset, timeoutSec, signal) =>
            call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal),
    };
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramConfig {
    botToken: string;
    chatId: string;
    enabled: boolean;
    /** herdr-telegram-progress on/off (default true when absent). */
    progress?: boolean;
}

const CONFIG_DIR = join(process.env.HOME ?? "~", ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "herdr-telegram.json");
/** Telegram messages must stay under 4096 chars; leave headroom for edits. */
export const MAX_MESSAGE_CHARS = 3800;

export function readConfigFile(path: string = CONFIG_PATH): TelegramConfig | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TelegramConfig>;
        if (typeof raw.botToken !== "string" || raw.botToken.length === 0) return undefined;
        if (typeof raw.chatId !== "string" || raw.chatId.length === 0) return undefined;
        return { botToken: raw.botToken, chatId: raw.chatId, enabled: raw.enabled !== false, progress: raw.progress };
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
        return { config: { botToken: envToken, chatId: envChat, enabled: file?.enabled ?? true, progress: file?.progress }, source: "env", split: false };
    }
    if (envToken || envChat) {
        // Partial env config is never usable — say so rather than half-work.
        return { config: undefined, source: "none", split: true };
    }
    return { config: file, source: file ? "file" : "none", split: false };
}

/** The live chat for this process, re-read from config on every call (so
 *  /telegram on|off takes effect immediately). */
export function getChat(): { client: TelegramClient; chatId: string } | undefined {
    const { config } = loadConfig();
    if (!config || !config.enabled) return undefined;
    return { client: createTelegramClient(config.botToken), chatId: config.chatId };
}

/** Progress push is enabled unless config.progress === false (or env force-off). */
export function progressEnabled(
    env: Record<string, string | undefined> = process.env,
    path: string = CONFIG_PATH,
): boolean {
    if (env.TELEGRAM_PROGRESS === "0") return false;
    const { config } = loadConfig(env, path);
    return config !== undefined && config.enabled && config.progress !== false;
}

// ---------------------------------------------------------------------------
// Text helpers (shared by both extensions' renderers)
// ---------------------------------------------------------------------------

export function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** Compact elapsed time: "0s", "59s", "1m", "3m 14s". */
export function formatElapsed(ms: number): string {
    const secs = Math.max(0, Math.floor(ms / 1000));
    if (secs < 60) return `${secs}s`;
    const mins = Math.floor(secs / 60);
    return `${mins}m${secs % 60 ? ` ${secs % 60}s` : ""}`;
}

/** Compact token counts: 950, 12.3k, 1.2M. */
export function formatTokens(n: number): string {
    if (n < 1000) return String(n);
    if (n < 1_000_000) {
        const k = (n / 1000).toFixed(1).replace(/\.0$/, "");
        return `${k}k`;
    }
    return `${(n / 1_000_000).toFixed(1)}M`;
}

// ---------------------------------------------------------------------------
// PollHub — the ONE getUpdates loop per process (globalThis singleton)
// ---------------------------------------------------------------------------

/**
 * A subscriber returns true when it consumed the update (routing stops);
 * false lets the next subscriber see it. Handlers must be synchronous and
 * must never throw (the hub runs detached — a throw would only kill the loop).
 */
export type UpdateHandler = (update: TelegramUpdate) => boolean;

export interface PollLease {
    release(): void;
}

export interface PollHub {
    /** Subscribe; the shared loop starts with the first subscriber. */
    subscribe(handler: UpdateHandler): PollLease;
    /** Active subscriber count (diagnostics/tests). */
    readonly subscriberCount: number;
    /** Whether the loop is currently polling (diagnostics/tests). */
    readonly polling: boolean;
}

interface PollHubState {
    handlers: UpdateHandler[];
    offset: number;
    running: boolean;
    /** AbortController for the in-flight getUpdates (dropped on stop). */
    inflight?: AbortController;
}

const POLL_HUB_KEY = Symbol.for("herdr-telegram.pollhub");

function createPollHub(): PollHub {
    const state: PollHubState = { handlers: [], offset: 0, running: false };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());

    const dispatch = (updates: TelegramUpdate[], chatId: string, client: TelegramClient): void => {
        for (const u of updates) {
            state.offset = Math.max(state.offset, u.update_id + 1);
            let consumed = false;
            for (const h of [...state.handlers]) {
                try {
                    if (h(u)) {
                        consumed = true;
                        break;
                    }
                } catch {
                    /* a broken subscriber must not kill the loop */
                }
            }
            if (consumed || !u.callback_query) continue;
            // Nobody claimed a button tap: ack it (the phone spinner otherwise
            // spins out) — but only from the allowlisted chat, like everywhere.
            if (String(u.callback_query.message?.chat?.id ?? "") === chatId) {
                client.answerCallbackQuery(u.callback_query.id, "expired").catch(() => {});
            }
        }
    };

    const loop = async (): Promise<void> => {
        let backoff = 500;
        while (state.running && state.handlers.length > 0) {
            const chat = getChat();
            if (!chat) {
                // Config off/absent (e.g. /telegram off mid-question): stop
                // hitting the API, re-check cheaply until subscribers leave.
                await sleep(1000);
                continue;
            }
            state.inflight = new AbortController();
            try {
                const updates = await chat.client.getUpdates(state.offset, 25, state.inflight.signal);
                backoff = 500;
                if (updates.length > 0) {
                    dispatch(updates, chat.chatId, chat.client);
                } else {
                    // Long-poll servers hold ~25s; a stub or misbehaving proxy
                    // that returns instantly must not spin this loop.
                    await sleep(250);
                }
            } catch (err) {
                if (!state.running || state.handlers.length === 0) return;
                if (err instanceof Error && err.name === "AbortError") continue;
                // 409 (another pi process polling) or transient failure: back off.
                await sleep(backoff + Math.random() * backoff);
                backoff = Math.min(backoff * 2, 5000);
            } finally {
                state.inflight = undefined;
            }
        }
        state.running = false;
    };

    return {
        get subscriberCount(): number {
            return state.handlers.length;
        },
        get polling(): boolean {
            return state.running && state.handlers.length > 0;
        },
        subscribe(handler: UpdateHandler): PollLease {
            state.handlers.push(handler);
            if (!state.running) {
                state.running = true;
                loop().catch(() => {
                    // Defensive: loop() handles its own errors; never let a
                    // detached promise rejection escape.
                });
            }
            let released = false;
            return {
                release(): void {
                    if (released) return;
                    released = true;
                    state.handlers = state.handlers.filter((h) => h !== handler);
                    if (state.handlers.length === 0) {
                        state.running = false;
                        state.inflight?.abort();
                        state.inflight = undefined;
                    }
                },
            };
        },
    };
}

/**
 * The process-wide PollHub. globalThis-keyed because pi loads every extension
 * file with its own jiti instance (moduleCache: false) — module state is NOT
 * shared between importers (spike: scripts/spike-jiti-singleton.mts).
 */
export function getSharedPollHub(): PollHub {
    const g = globalThis as typeof globalThis & { [POLL_HUB_KEY]?: PollHub };
    return (g[POLL_HUB_KEY] ??= createPollHub());
}

/** Test hook: drop the shared hub so a clean one is created next. */
export function __resetSharedPollHubForTests(): void {
    const g = globalThis as typeof globalThis & { [POLL_HUB_KEY]?: PollHub };
    delete g[POLL_HUB_KEY];
}

// The default export is a no-op: this file is shared plumbing, not an
// extension. The no-op keeps pi's *.ts auto-discovery happy if this file is
// symlinked/copied into the extensions dir (it always is — install.sh and the
// symlink convention copy every root *.ts).
export default function herdrTelegramCoreNoop(): void {
    /* intentionally empty */
}
