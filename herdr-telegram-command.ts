/**
 * herdr-telegram-command — impromptu Telegram control of THIS pi session (M1).
 *
 * From the phone: steer the running agent, queue a follow-up, abort the run —
 * or just type plain text and it lands as user input (steer when streaming,
 * new turn when idle). Cross-pane steering (/steer <pane>), /read, /keys,
 * /wait and /new spawn arrive in M2/M3 over Herdr's socket
 * (plans/herdr-telegram-command.md in jreb-memory).
 *
 * Self-steering uses pi's first-class in-process API — `pi.sendUserMessage`
 * with `deliverAs: "steer" | "followUp"` — never terminal injection.
 *
 * Routing (claim order on the shared PollHub, per plans §2–§3):
 *   - "/"-prefixed text from the allowlisted chat → ours, always (the ask
 *     wizard ignores "/" text; progress owns callback_query buttons only).
 *   - plain text → ours ONLY when this process is the elected controller
 *     (heartbeat file) AND no ask_user_question is open here (the wizard owns
 *     open questions — same-precedence guard via tool lifecycle tracking,
 *     the trick herdr-blocked-on-question.ts uses).
 *
 * Controller election: ~/.pi/agent/herdr-telegram-controller.json —
 * {host, pid, paneId, heartbeatAt}, 10 s beat, 30 s stale threshold, first
 * stale-detector wins; races are benign (Telegram's exclusive getUpdates
 * long-poll still routes each update to exactly one process).
 *
 * M1 scope: /steer [self] <text> · /followup (alias /queue) · /stop · /help ·
 * /rc on|off|status (also a TUI command) · plain text. Non-self targets parse
 * but answer "M2" for now.
 *
 * Zero runtime dependencies; network I/O only via herdr-telegram-core.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type PollHub, type PollLease, type TelegramUpdate, getChat as coreGetChat, getSharedPollHub } from "./herdr-telegram-core.ts";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Command grammar (pure — smoke-tested)
// ---------------------------------------------------------------------------

export type CommandKind = "steer" | "followup" | "stop" | "help" | "rc" | "plain";

export interface ParsedCommand {
    kind: CommandKind;
    /** Explicit target: "self", a pane id (wA:p1) or an agent name. M1 executes only "self". */
    target: string;
    /** Remainder text (steer/followup/rc args). */
    text: string;
}

/** Words that look like targets: "self" (explicit), pane ids (wA:p1), or a
 *  name from the KNOWN live-agent list (roster-aware targeting arrives M2 —
 *  a bare lowercase word is NOT a target: /steer fix the tests steers "fix
 *  the tests", not agent "fix"). */
function looksLikeTarget(word: string, knownNames: readonly string[] = []): boolean {
    if (word === "self") return true;
    if (/^[a-zA-Z]\w*:[a-zA-Z]\w*$/.test(word)) return true; // pane id wB:p1
    return knownNames.includes(word);
}

/**
 * Parse one Telegram text message into a command. Returns undefined for
 * non-command text (plain) is NOT undefined — it is {kind:"plain"} — while
 * empty/absent text is undefined. Unknown "/"-commands parse as {kind:"help"}
 * so the handler can claim them and reply with the cheatsheet.
 */
export function parseCommand(raw: string | undefined, knownNames: readonly string[] = []): ParsedCommand | undefined {
    const text = (raw ?? "").trim();
    if (text.length === 0) return undefined;
    if (!text.startsWith("/")) return { kind: "plain", target: "self", text };

    const space = text.indexOf(" ");
    const head = (space === -1 ? text : text.slice(0, space)).toLowerCase();
    const rest = space === -1 ? "" : text.slice(space + 1).trim();
    const body = (): { target: string; text: string } => {
        const firstWord = rest.split(/\s+/)[0] ?? "";
        if (firstWord && looksLikeTarget(firstWord, knownNames) && rest.slice(firstWord.length).trim().length > 0) {
            return { target: firstWord, text: rest.slice(firstWord.length).trim() };
        }
        return { target: "self", text: rest };
    };

    switch (head) {
        case "/steer": {
            const b = body();
            return { kind: "steer", target: b.target, text: b.text };
        }
        case "/followup":
        case "/queue": {
            const b = body();
            return { kind: "followup", target: b.target, text: b.text };
        }
        case "/stop":
            return { kind: "stop", target: rest && looksLikeTarget(rest, knownNames) ? rest : "self", text: "" };
        case "/help":
        case "/start":
            return { kind: "help", target: "self", text: "" };
        case "/rc":
            return { kind: "rc", target: "self", text: rest };
        default:
            return { kind: "help", target: "self", text: "" };
    }
}

export function renderHelp(): string {
    return [
        "🎛 <b>pi remote control</b>",
        "<code>&lt;text&gt;</code> — steer this session (or start a turn when idle)",
        "<code>/steer [self] &lt;text&gt;</code> — redirect mid-run",
        "<code>/followup [self] &lt;text&gt;</code> — queue after current work",
        "<code>/stop</code> — abort the current run",
        "<code>/rc on|off|status</code> — plain-text control toggle",
        "<i>/read /keys /wait /new — coming with Herdr pane control (M2/M3)</i>",
    ].join("\n");
}

// ---------------------------------------------------------------------------
// Controller election (file protocol — injectable for smoke tests)
// ---------------------------------------------------------------------------

export const CONTROLLER_PATH = join(process.env.HOME ?? "~", ".pi", "agent", "herdr-telegram-controller.json");
export const CONTROLLER_BEAT_MS = 10_000;
export const CONTROLLER_STALE_MS = 30_000;

export interface ControllerRecord {
    host: string;
    pid: number;
    paneId: string;
    heartbeatAt: number;
}

export interface ControllerDeps {
    path?: string;
    host?: string;
    pid?: number;
    paneId?: string;
    now?: () => number;
}

export interface Controller {
    /** User flipped /rc on: start participating (beat loop unref'd). */
    enable(): void;
    /** User flipped /rc off: stop; release the file if it is ours. */
    disable(): void;
    /** True iff the user enabled THIS process and the file is ours & fresh. */
    isController(): boolean;
    /** One beat/try-takeover cycle (exported for tests). */
    beatOnce(): void;
    /** Release on shutdown if ours (no-op otherwise). */
    releaseIfOurs(): void;
    /** Read-only view for /rc status. */
    describe(): { enabled: boolean; mine: boolean; record: ControllerRecord | undefined; stale: boolean };
}

function readController(path: string): ControllerRecord | undefined {
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<ControllerRecord>;
        if (typeof raw.host !== "string" || typeof raw.pid !== "number" || typeof raw.heartbeatAt !== "number") return undefined;
        return { host: raw.host, pid: raw.pid, paneId: typeof raw.paneId === "string" ? raw.paneId : "", heartbeatAt: raw.heartbeatAt };
    } catch {
        return undefined;
    }
}

function writeController(path: string, record: ControllerRecord): void {
    writeFileSync(path, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
    chmodSync(path, 0o600);
}

export function createController(deps: ControllerDeps = {}): Controller {
    const path = deps.path ?? CONTROLLER_PATH;
    const host = deps.host ?? hostname();
    const pid = deps.pid ?? process.pid;
    const paneId = deps.paneId ?? process.env.HERDR_PANE_ID ?? "";
    const now = deps.now ?? Date.now;
    let enabled = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const mine = (r: ControllerRecord): boolean => r.host === host && r.pid === pid && r.paneId === paneId;

    return {
        enable(): void {
            enabled = true;
            this.beatOnce();
            if (!timer) {
                timer = setInterval(() => this.beatOnce(), CONTROLLER_BEAT_MS);
                timer.unref?.();
            }
        },
        disable(): void {
            enabled = false;
            if (timer) {
                clearInterval(timer);
                timer = undefined;
            }
            this.releaseIfOurs();
        },
        beatOnce(): void {
            if (!enabled) return;
            const current = readController(path);
            if (!current || mine(current) || now() - current.heartbeatAt > CONTROLLER_STALE_MS) {
                // Absent, ours, or stale: (re)claim. Write-then-reverify keeps a
                // simultaneous takeover benign — loser's next beat sees foreign.
                writeController(path, { host, pid, paneId, heartbeatAt: now() });
            }
        },
        isController(): boolean {
            if (!enabled) return false;
            const current = readController(path);
            return !!current && mine(current) && now() - current.heartbeatAt <= CONTROLLER_STALE_MS;
        },
        releaseIfOurs(): void {
            const current = readController(path);
            if (current && mine(current) && existsSync(path)) {
                try {
                    rmSync(path);
                } catch {
                    /* best-effort */
                }
            }
        },
        describe() {
            const record = readController(path);
            const stale = !!record && now() - record.heartbeatAt > CONTROLLER_STALE_MS;
            return { enabled, mine: !!record && mine(record), record, stale };
        },
    };
}

// ---------------------------------------------------------------------------
// Claim predicate (pure — smoke-tested)
// ---------------------------------------------------------------------------

export interface ClaimState {
    /** This process participates (/rc on). */
    enabled: boolean;
    /** This process holds the controller role right now. */
    controller: boolean;
    /** An ask_user_question is open in THIS process → the wizard owns plain text. */
    askDepth: number;
    /** Allowlisted chat id (from config). */
    chatId: string;
}

/**
 * Which inbound Telegram updates this extension claims on the shared hub.
 * "/"-text is always ours (unknowns reply help); plain text only as the
 * controller with no open question; callback queries are never ours.
 */
export function claimsUpdate(update: TelegramUpdate, state: ClaimState): boolean {
    const msg = update.message;
    if (!msg) return false;
    if (String(msg.chat?.id ?? "") !== state.chatId) return false;
    const text = (msg.text ?? "").trim();
    if (text.length === 0) return false;
    if (text.startsWith("/")) return true;
    return state.enabled && state.controller && state.askDepth === 0;
}

// ---------------------------------------------------------------------------
// Command handler (wiring — injectable deps like createRunTracker)
// ---------------------------------------------------------------------------

export interface CommandDeps {
    getChat?: () => { client: { sendMessage(chatId: string, text: string): Promise<unknown> }; chatId: string } | undefined;
    pollHub?: PollHub;
    controller?: Controller;
    now?: () => number;
    /** Steer self (default: pi.sendUserMessage with idle/steer dispatch). */
    send?: (text: string, mode: "auto" | "steer" | "followUp") => void;
    /** Abort the run (default: ctx.abort()). */
    abort?: () => void;
    /** Streaming probe (default: ctx.isIdle()). */
    isIdle?: () => boolean;
}

export interface CommandHandler {
    /** PollHub UpdateHandler — claim-routed per claimsUpdate. */
    handleUpdate(update: TelegramUpdate): boolean;
    /** Test/diagnostic access. */
    readonly askDepth: number;
    onToolStart(toolName: string): void;
    onToolEnd(toolName: string): void;
    onShutdown(): void;
}

export function createCommandHandler(deps: CommandDeps = {}): CommandHandler {
    const getChat = deps.getChat ?? coreGetChat;
    const hub = deps.pollHub ?? getSharedPollHub();
    const controller = deps.controller ?? createController();
    const now = deps.now ?? Date.now;
    const isIdle = deps.isIdle ?? (() => ctxRef?.isIdle() ?? true);
    const doSend = deps.send ?? ((text, mode) => {
        const pi = piRef;
        if (!pi) return;
        if (mode === "auto" && !isIdle()) mode = "steer";
        if (mode === "auto" || isIdle()) pi.sendUserMessage(text);
        else pi.sendUserMessage(text, { deliverAs: mode });
    });
    const doAbort = deps.abort ?? (() => {
        try {
            ctxRef?.abort();
        } catch {
            /* best-effort */
        }
    });

    let piRef: ExtensionAPI | undefined;
    let ctxRef: ExtensionContext | undefined;
    let lease: PollLease | undefined;
    let askDepth = 0;

    const reply = (text: string): void => {
        const chat = safeChat();
        if (chat) chat.client.sendMessage(chat.chatId, text).catch(() => {});
    };
    const safeChat = (): ReturnType<typeof getChat> => {
        try {
            return getChat();
        } catch {
            return undefined;
        }
    };

    const execute = (cmd: ParsedCommand): void => {
        // Non-self targets need the Herdr socket (M2). Parse them, say so.
        if ((cmd.kind === "steer" || cmd.kind === "followup") && cmd.target !== "self") {
            reply(`⏳ steering <code>${cmd.target}</code> arrives with Herdr pane control (M2) — v1 steers this session only.`);
            return;
        }
        switch (cmd.kind) {
            case "plain":
            case "steer":
            case "followup": {
                if (!cmd.text) {
                    reply(`✏️ empty ${cmd.kind === "plain" ? "message" : cmd.kind} — nothing sent.`);
                    return;
                }
                const mode = cmd.kind === "followup" ? "followUp" : cmd.kind === "steer" ? "steer" : "auto";
                doSend(cmd.text, mode);
                return; // the message itself is the receipt (visible in the TUI transcript)
            }
            case "stop":
                doAbort();
                reply("⏹ stop requested");
                return;
            case "help":
                reply(renderHelp());
                return;
            case "rc":
                replyRc(cmd.text);
                return;
        }
    };

    /** /rc from Telegram (the TUI command handles the local variant). */
    const replyRc = (args: string): void => {
        const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "status";
        switch (sub) {
            case "on":
                controller.enable();
                reply(controller.isController() ? "🎧 this session now hears plain text (controller elected)" : "🎧 enabled — another fresh controller is active; standing by for takeover");
                return;
            case "off":
                controller.disable();
                reply("🔕 plain-text control off");
                return;
            default: {
                const d = controller.describe();
                const who = d.record ? `${d.record.host} pid ${d.record.pid}${d.record.paneId ? ` (${d.record.paneId})` : ""}` : "nobody";
                const age = d.record ? Math.max(0, Math.round((now() - d.record.heartbeatAt) / 1000)) : -1;
                reply(`🎛 rc: ${d.enabled ? "enabled" : "disabled"} · controller: ${who}${d.stale ? " (stale)" : ""} · heartbeat ${age < 0 ? "—" : `${age}s ago`}`);
                return;
            }
        }
    };

    return {
        get askDepth() {
            return askDepth;
        },
        onToolStart(toolName): void {
            if (toolName === "ask_user_question") askDepth += 1;
        },
        onToolEnd(toolName): void {
            if (toolName === "ask_user_question" && askDepth > 0) askDepth -= 1;
        },
        onShutdown(): void {
            controller.releaseIfOurs();
            lease?.release();
            lease = undefined;
        },
        handleUpdate(update): boolean {
            const chat = safeChat();
            if (!chat) return false;
            if (!claimsUpdate(update, { enabled: controller.describe().enabled, controller: controller.isController(), askDepth, chatId: chat.chatId })) return false;
            const cmd = parseCommand(update.message?.text);
            if (!cmd) return false; // claimed as ours but nothing to do — let it drop
            execute(cmd);
            return true;
        },
    };
}

/** Bind the handler to the persistent hub subscription (process lifetime). */
export function bindHandler(handler: CommandHandler, hub: PollHub = getSharedPollHub()): PollLease | undefined {
    try {
        return hub.subscribe((u) => handler.handleUpdate(u));
    } catch {
        return undefined;
    }
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
    // ONE controller shared by the Telegram path (inside the handler) and the
    // TUI /rc command below — both flip the same election state.
    const controller = createController();
    const handler = createCommandHandler({ controller });
    const lease = bindHandler(handler);
    void lease; // released on shutdown

    const safe = (fn: () => void): void => {
        try {
            fn();
        } catch {
            /* control must never disturb the session */
        }
    };

    pi.on("tool_execution_start", (event) => safe(() => handler.onToolStart(event.toolName)));
    pi.on("tool_execution_end", (event) => safe(() => handler.onToolEnd(event.toolName)));
    pi.on("session_shutdown", () => safe(() => handler.onShutdown()));

    pi.registerCommand("rc", {
        description: "Telegram remote control: plain-text steering on/off + controller status",
        handler: async (args: string, ctx: ExtensionContext) => {
            if (!coreGetChat()) {
                ctx.ui.notify("No Telegram config — run /telegram setup first.", "error");
                return;
            }
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "status";
            switch (sub) {
                case "on": {
                    controller.enable();
                    ctx.ui.notify(
                        controller.isController()
                            ? "🎧 Remote control ON — this session hears plain-text Telegram messages as steering (/commands always work)."
                            : "🎧 Enabled — another fresh controller is active; this session stands by for takeover.",
                        "info",
                    );
                    return;
                }
                case "off": {
                    controller.disable();
                    ctx.ui.notify("🔕 Remote control OFF — plain text from Telegram is ignored again (/commands still work).", "info");
                    return;
                }
                default: {
                    const d = controller.describe();
                    const who = d.record ? `${d.record.host} pid ${d.record.pid}${d.record.paneId ? ` (${d.record.paneId})` : ""}` : "nobody";
                    const age = d.record ? Math.max(0, Math.round((Date.now() - d.record.heartbeatAt) / 1000)) : -1;
                    const lines = [
                        `rc: ${d.enabled ? "enabled here" : "disabled here"} · controller: ${who}${d.stale ? " (stale)" : ""}`,
                        `heartbeat: ${age < 0 ? "—" : `${age}s ago`} · plain text ${d.mine && !d.stale ? "→ this session" : "ignored here"}`,
                        `this session: ${process.env.HERDR_PANE_ID ? `pane ${process.env.HERDR_PANE_ID}` : `pid ${process.pid} (not under Herdr)`} · poll hub: ${getSharedPollHub().subscriberCount} subscriber(s)`,
                    ];
                    ctx.ui.notify(lines.join("\n"), "info");
                    return;
                }
            }
        },
    });
}
