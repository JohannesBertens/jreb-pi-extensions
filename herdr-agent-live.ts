/**
 * herdr-agent-live — the live roster: one Telegram message per machine that
 * edits itself as agents change, powered by Herdr's `events.subscribe` stream.
 *
 * Mechanics (verified live, see jreb-memory research/herdr-event-stream.md):
 *   → events.subscribe {subscriptions} → subscription_started ack, then
 *   ← {"event","data"} pushes on the SAME connection, forever (no id field).
 *
 * Spike verdicts baked in (2026-08-30, herdr 0.8.2 / protocol 20):
 * - `pane.agent_detected` in the subscription set makes the replay burst heavy
 *   and the connection resets mid-replay (ECONNRESET after a released-agent
 *   replay event) — so we do NOT subscribe to it.
 * - `pane.agent_status_changed` is per-pane only → we maintain the pane-id set
 *   from `agent.list` and reconnect with a fresh subscription set on drift
 *   (replays make reconnects self-healing; state is re-read anyway).
 * - Foreign-source `pane.report_agent` reports are ignored (agent authority) —
 *   transitions can't be synthesized for tests; offline tests stub the socket.
 * - A connection-reset loop (replay pathology) degrades to interval polling
 *   instead of spinning.
 *
 * Ownership (ADR-0004): auto-on at session_start (TUI, under Herdr, Telegram
 * enabled, `liveRoster !== false`); a lock file (~/.pi/agent/herdr-roster.lock,
 * pid-liveness + heartbeat) elects ONE owner across pi sessions; takeovers adopt
 * the stored Telegram message id. Edits are silent; the only audible ping is a
 * →blocked transition. `/agents live on|off|status` (command registered by
 * herdr-agent-list.ts via registerLiveHandler).
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getChat, loadConfig, writeConfigFile, type TelegramClient } from "./herdr-telegram-core.ts";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";
import {
    herdrSocketPath,
    queryHerdrAgents,
    registerLiveHandler,
    renderRosterTelegram,
    sortAgents,
    type AgentQueryResult,
    type SocketFactory,
} from "./herdr-agent-list.ts";

// ---------------------------------------------------------------------------
// Lock file — single-owner election across pi sessions
// ---------------------------------------------------------------------------

const LOCK_PATH = join(process.env.HOME ?? "~", ".pi", "agent", "herdr-roster.lock");

export interface RosterLock {
    pid: number;
    /** ms epoch of the owner's last heartbeat. */
    heartbeat: number;
    /** Telegram message id of the live roster message (for orphan adoption). */
    messageId?: number;
}

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err) {
        // EPERM = exists but not ours; anything else (ESRCH) = dead.
        return (err as NodeJS.ErrnoException).code === "EPERM";
    }
}

export function readRosterLock(path: string = LOCK_PATH): RosterLock | undefined {
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<RosterLock>;
        if (typeof raw.pid !== "number" || typeof raw.heartbeat !== "number") return undefined;
        return { pid: raw.pid, heartbeat: raw.heartbeat, messageId: typeof raw.messageId === "number" ? raw.messageId : undefined };
    } catch {
        return undefined;
    }
}

function writeRosterLock(lock: RosterLock, path: string): void {
    try {
        writeFileSync(path, JSON.stringify(lock) + "\n", { mode: 0o600 });
    } catch {
        /* best effort — heartbeat staleness covers failures */
    }
}

export function releaseRosterLock(path: string = LOCK_PATH): void {
    const lock = readRosterLock(path);
    if (lock && lock.pid === process.pid) {
        try {
            rmSync(path);
        } catch {
            /* next owner's staleness check handles it */
        }
    }
}

// ---------------------------------------------------------------------------
// Live roster engine
// ---------------------------------------------------------------------------

export interface LiveKnobs {
    debounceMs?: number;
    throttleMs?: number;
    pollMs?: number;
    heartbeatMs?: number;
    staleMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
}

export interface LiveDeps {
    socketPath: string;
    host: string;
    selfPaneId?: string;
    queryAgents?: (socketPath: string) => Promise<AgentQueryResult>;
    socketFactory?: SocketFactory;
    lockPath?: string;
    knobs?: LiveKnobs;
    /** Test observability: every internal step reports a label. */
    onEvent?: (label: string) => void;
}

interface LiveState {
    running: boolean;
    fallback: boolean;
    knobs: Required<LiveKnobs>;
    deps: LiveDeps;
    messageId?: number;
    lastText?: string;
    lastEditAt: number;
    prevStatus: Map<string, string>;
    subscribedPanes: Set<string>;
    socket?: Socket;
    debounceTimer?: ReturnType<typeof setTimeout>;
    pollTimer?: ReturnType<typeof setInterval>;
    heartbeatTimer?: ReturnType<typeof setInterval>;
    reconnectTimer?: ReturnType<typeof setTimeout>;
    reconnectAttempts: number;
    connectedAt: number;
}

const DEFAULT_KNOBS: Required<LiveKnobs> = {
    debounceMs: 1500,
    throttleMs: 10_000,
    pollMs: 10_000,
    heartbeatMs: 30_000,
    staleMs: 90_000,
    reconnectBaseMs: 500,
    reconnectMaxMs: 5_000,
};

let state: LiveState | undefined;

const now = (): number => Date.now();

function subscriptionRequest(paneIds: string[]): string {
    return `${JSON.stringify({
        id: `pi:live:${now()}`,
        method: "events.subscribe",
        params: {
            subscriptions: [
                ...paneIds.map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })),
                { type: "pane.created" },
                { type: "pane.closed" },
                { type: "pane.exited" },
                { type: "layout.updated" },
                { type: "workspace.metadata_updated" },
            ],
        },
    })}\n`;
}

function liveFooter(): string {
    const d = new Date();
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return `\n📡 live · updated ${hhmm}`;
}

/** Start (or restart with new deps). Returns why it did NOT start, if it didn't. */
export function startLiveRoster(deps: LiveDeps): { started: boolean; reason?: string } {
    stopLiveRoster();
    const st: LiveState = {
        running: true,
        fallback: false,
        knobs: { ...DEFAULT_KNOBS, ...deps.knobs },
        deps,
        lastEditAt: 0,
        prevStatus: new Map(),
        subscribedPanes: new Set(),
        reconnectAttempts: 0,
        connectedAt: 0,
    };
    state = st;
    const emit = (label: string): void => deps.onEvent?.(label);
    const query = deps.queryAgents ?? queryHerdrAgents;
    const lockPath = deps.lockPath ?? LOCK_PATH;

    // --- Telegram output ------------------------------------------------------

    const send = async (text: string, opts: { silent?: boolean } = {}): Promise<number | undefined> => {
        const c = getChat();
        if (!c) return undefined;
        try {
            const { message_id } = await c.client.sendMessage(c.chatId, text, undefined, opts.silent ? { disableNotification: true } : undefined);
            return message_id;
        } catch {
            return undefined;
        }
    };

    const push = async (text: string): Promise<void> => {
        const c = getChat();
        let delivered = false;
        if (c && st.messageId !== undefined) {
            delivered = await c.client.editMessageText(c.chatId, st.messageId, text).catch(() => false);
        }
        if (delivered) {
            emit("edit-ok");
        } else {
            const id = await send(text, { silent: true });
            if (id !== undefined) {
                st.messageId = id;
                emit("sent-new");
                writeRosterLock({ pid: process.pid, heartbeat: now(), messageId: id }, lockPath);
            } else {
                emit("telegram-failed");
            }
        }
        st.lastText = text;
        st.lastEditAt = now();
    };

    const pingBlocked = (agent: string, paneId: string): void => {
        void send(`⚠️ blocked: ${agent} · ${paneId} (needs attention)`).then(() => emit("ping-blocked"));
    };

    // --- state refresh ----------------------------------------------------------

    const refresh = async (): Promise<void> => {
        if (!st.running) return;
        const q = await query(deps.socketPath);
        if (!q.ok) {
            emit("query-failed");
            return;
        }
        const agents = sortAgents(q.agents);
        const nextStatus = new Map(agents.map((a) => [a.pane_id, a.agent_status]));

        // Pane-set drift → reconnect with a fresh per-pane subscription set.
        const paneIds = agents.map((a) => a.pane_id);
        const drifted = paneIds.some((p) => !st.subscribedPanes.has(p)) || [...st.subscribedPanes].some((p) => !nextStatus.has(p));
        if (drifted && !st.fallback) {
            st.subscribedPanes = new Set(paneIds);
            reconnectNow();
        }

        // Blocked-transition pings: anything newly blocked — a real
        // working→blocked flip OR an agent first seen already blocked.
        for (const a of agents) {
            const prev = st.prevStatus.get(a.pane_id);
            if (a.agent_status === "blocked" && prev !== "blocked") pingBlocked(a.agent, a.pane_id);
        }
        st.prevStatus = nextStatus;

        const text = renderRosterTelegram(deps.host, agents, deps.selfPaneId) + liveFooter();
        if (text !== st.lastText && now() - st.lastEditAt >= st.knobs.throttleMs) {
            await push(text);
        } else {
            emit(text !== st.lastText ? "throttled" : "unchanged");
        }
    };

    const scheduleRefresh = (): void => {
        if (st.debounceTimer) clearTimeout(st.debounceTimer);
        st.debounceTimer = setTimeout(() => {
            st.debounceTimer = undefined;
            void refresh();
        }, st.knobs.debounceMs);
        st.debounceTimer.unref?.();
    };

    // --- socket listener (reset-tolerant, poll fallback) -------------------------

    const enterFallback = (): void => {
        if (st.fallback) return;
        st.fallback = true;
        emit("poll-fallback");
        st.pollTimer = setInterval(() => void refresh(), st.knobs.pollMs);
        st.pollTimer.unref?.();
    };

    const scheduleReconnect = (): void => {
        if (!st.running || st.fallback || st.reconnectTimer) return;
        const stableFor = st.connectedAt > 0 ? now() - st.connectedAt : Number.POSITIVE_INFINITY;
        if (stableFor > 5_000) st.reconnectAttempts = 0;
        st.reconnectAttempts += 1;
        if (st.reconnectAttempts > 3 && stableFor < 2_000) {
            // Replay pathology (ECONNRESET loop): degrade to interval polling.
            st.socket?.destroy();
            st.socket = undefined;
            enterFallback();
            return;
        }
        const base = Math.min(st.knobs.reconnectBaseMs * 2 ** (st.reconnectAttempts - 1), st.knobs.reconnectMaxMs);
        const delay = base + Math.random() * base;
        st.reconnectTimer = setTimeout(() => {
            st.reconnectTimer = undefined;
            connect();
        }, delay);
        st.reconnectTimer.unref?.();
        emit(`reconnect-in-${Math.round(delay)}ms`);
    };

    const connect = (): void => {
        if (!st.running || st.fallback) return;
        const factory: SocketFactory = deps.socketFactory ?? ((p: string) => createConnection(p));
        let socket: Socket;
        try {
            socket = factory(deps.socketPath);
        } catch {
            scheduleReconnect();
            return;
        }
        st.socket = socket;
        let buffer = "";
        socket.on("connect", () => {
            st.connectedAt = now();
            socket.write(subscriptionRequest([...st.subscribedPanes]));
            emit("subscribed");
        });
        socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            let nl: number;
            while ((nl = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, nl).trim();
                buffer = buffer.slice(nl + 1);
                if (!line) continue;
                let message: { id?: string; event?: string };
                try {
                    message = JSON.parse(line);
                } catch {
                    continue;
                }
                // Pushes carry no id; acks do. Any push invalidates the roster.
                if (message.id === undefined && typeof message.event === "string") scheduleRefresh();
            }
        });
        const dead = (): void => {
            if (st.socket === socket) st.socket = undefined;
            scheduleReconnect();
        };
        socket.on("error", dead);
        socket.on("end", dead);
        socket.on("close", dead);
    };

    const reconnectNow = (): void => {
        if (!st.running || st.fallback) return;
        if (st.reconnectTimer) clearTimeout(st.reconnectTimer);
        st.reconnectTimer = undefined;
        st.socket?.destroy();
        st.socket = undefined;
        connect();
    };

    // --- heartbeat: lock liveness + config self-check -----------------------------

    st.heartbeatTimer = setInterval(() => {
        writeRosterLock({ pid: process.pid, heartbeat: now(), messageId: st.messageId }, lockPath);
        const { config } = loadConfig();
        if (!config || !config.enabled || config.liveRoster === false) {
            emit("config-disabled-self-stop");
            stopLiveRoster("⚪ live roster off (config)");
        }
    }, st.knobs.heartbeatMs);
    st.heartbeatTimer.unref?.();

    // --- go: initial read (gives the pane set), then subscribe --------------------

    void (async () => {
        const q = await query(deps.socketPath);
        if (q.ok) st.subscribedPanes = new Set(q.agents.map((a) => a.pane_id));
        if (!st.running) return;
        connect();
        await refresh();
    })();

    return { started: true };
}

/** Stop the listener. Optionally edit the roster message with a final note. */
export function stopLiveRoster(finalNote?: string): void {
    const st = state;
    state = undefined;
    if (!st) return;
    st.running = false;
    if (st.debounceTimer) clearTimeout(st.debounceTimer);
    if (st.pollTimer) clearInterval(st.pollTimer);
    if (st.heartbeatTimer) clearInterval(st.heartbeatTimer);
    if (st.reconnectTimer) clearTimeout(st.reconnectTimer);
    st.socket?.destroy();
    st.socket = undefined;
    if (finalNote !== undefined) {
        const text = `${st.lastText ?? "📡 Herdr live roster"}\n${finalNote}`;
        const c = getChat();
        if (c && st.messageId !== undefined) void c.client.editMessageText(c.chatId, st.messageId, text).catch(() => {});
    }
}

export function liveRosterStatus(): { running: boolean; fallback: boolean; messageId?: number; pid: number } {
    return { running: state?.running ?? false, fallback: state?.fallback ?? false, messageId: state?.messageId, pid: process.pid };
}

// ---------------------------------------------------------------------------
// Election + /agents live command handling
// ---------------------------------------------------------------------------

export function acquireRosterLock(lockPath: string = LOCK_PATH): { acquired: boolean; ownerPid?: number } {
    const lock = readRosterLock(lockPath);
    if (lock && lock.pid !== process.pid) {
        const staleMs = state?.knobs.staleMs ?? DEFAULT_KNOBS.staleMs;
        if (pidAlive(lock.pid) && now() - lock.heartbeat < staleMs) return { acquired: false, ownerPid: lock.pid };
    }
    // Take over: no lock, dead owner, or stale heartbeat — adopt its message id.
    writeRosterLock({ pid: process.pid, heartbeat: now(), messageId: lock?.messageId }, lockPath);
    return { acquired: true };
}

/** session_start auto-start gate: TUI + Herdr + Telegram on + flag not false + lock won. */
export function maybeAutoStart(socketPath: string | undefined): { started: boolean; reason?: string } {
    if (!socketPath) return { started: false, reason: "not under Herdr" };
    const { config } = loadConfig();
    if (!config || !config.enabled) return { started: false, reason: "telegram not configured/enabled" };
    if (config.liveRoster === false) return { started: false, reason: "liveRoster disabled in config" };
    const lockPath = join(process.env.HOME ?? "~", ".pi", "agent", "herdr-roster.lock");
    const election = acquireRosterLock(lockPath);
    if (!election.acquired) return { started: false, reason: `another session owns the roster (pid ${election.ownerPid})` };
    return startLiveRoster({ socketPath, host: hostname(), selfPaneId: process.env.HERDR_PANE_ID, lockPath });
}

export async function handleLiveCommand(sub: string, ctx: ExtensionContext): Promise<void> {
    const socketPath = herdrSocketPath();
    const { config } = loadConfig();
    const lockPath = join(process.env.HOME ?? "~", ".pi", "agent", "herdr-roster.lock");
    switch (sub) {
        case "on": {
            if (!config || !config.enabled) {
                ctx.ui.notify("Telegram not configured/enabled — run /telegram setup first.", "error");
                return;
            }
            writeConfigFile({ ...config, liveRoster: true });
            if (liveRosterStatus().running) {
                ctx.ui.notify("Live roster already running in this session.", "info");
                return;
            }
            const election = acquireRosterLock(lockPath);
            if (!election.acquired) {
                ctx.ui.notify(`Live roster owned by another session (pid ${election.ownerPid}) — it keeps updating; /agents still works here.`, "info");
                return;
            }
            if (!socketPath) {
                ctx.ui.notify("not running under Herdr — the live roster needs the Herdr socket.", "error");
                return;
            }
            startLiveRoster({ socketPath, host: hostname(), selfPaneId: process.env.HERDR_PANE_ID, lockPath });
            ctx.ui.notify("Live roster on — one Telegram message, edited in place as agents change (silent; ⚠️ ping on blocked only).", "info");
            return;
        }
        case "off": {
            if (config) writeConfigFile({ ...config, liveRoster: false });
            if (liveRosterStatus().running) stopLiveRoster("⚪ live roster off");
            releaseRosterLock(lockPath);
            ctx.ui.notify("Live roster off (config saved; auto-start disabled).", "info");
            return;
        }
        default: {
            const lock = readRosterLock(lockPath);
            const running = liveRosterStatus();
            const owner = lock
                ? pidAlive(lock.pid)
                    ? `pid ${lock.pid}${lock.pid === process.pid ? " (this session)" : ""}`
                    : "stale"
                : "none";
            const lines = [
                `live roster: ${config?.liveRoster === false ? "disabled in config" : "enabled (default)"}`,
                `this session: ${running.running ? `running${running.fallback ? " (poll fallback)" : ""}` : "not running"}`,
                `lock owner: ${owner}${lock?.messageId !== undefined ? ` · msg ${lock.messageId}` : ""}`,
                "/agents live on · off — silent edits, ⚠️ ping on blocked transitions; one owner across sessions.",
            ];
            ctx.ui.notify(lines.join("\n"), "info");
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // herdr-agent-list.ts owns the /agents command; we supply the `live` arm.
    registerLiveHandler(handleLiveCommand);

    pi.on("session_start", async (_event, ctx) => {
        // TUI only — headless modes have no Herdr pane lifecycle to track.
        if (ctx?.mode !== "tui") return;
        const result = maybeAutoStart(herdrSocketPath());
        if (result.started) {
            ctx?.ui?.notify?.("📡 live roster: this session owns the Telegram fleet message.", "info");
        } else if (result.reason && !result.reason.includes("not under Herdr") && !result.reason.includes("another session")) {
            ctx?.ui?.notify?.(`📡 live roster not started: ${result.reason}`, "info");
        }
    });

    // Best-effort lock release; a hard kill is covered by pid-liveness takeover.
    process.once("exit", () => releaseRosterLock());
}
