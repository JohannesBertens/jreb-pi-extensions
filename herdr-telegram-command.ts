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
import { MAX_MESSAGE_CHARS, type PollHub, type PollLease, type TelegramUpdate, escapeHtml, getChat as coreGetChat, getSharedPollHub, oneLine } from "./herdr-telegram-core.ts";
import { type HerdrRequestOptions, herdrRequest, herdrSocketPath } from "./herdr-socket.ts";
import { type HerdrAgentRow, renderRosterTelegram, sortAgents } from "./herdr-agent-list.ts";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Command grammar (pure — smoke-tested)
// ---------------------------------------------------------------------------

export type CommandKind = "steer" | "followup" | "stop" | "help" | "rc" | "plain" | "read" | "keys" | "wait" | "agents" | "new";

export interface ParsedCommand {
    kind: CommandKind;
    /** Explicit target: "self", a pane id (wA:p1) or an agent name. For /new: the @name ("" = auto). */
    target: string;
    /** Remainder text (steer/followup/rc args) or key list (keys). */
    text: string;
    /** /read line count. */
    lines?: number;
    /** /wait timeout in ms. */
    timeoutMs?: number;
    /** /new agent kind (default pi). */
    agentKind?: string;
    /** /new working directory. */
    cwd?: string;
    /** /new model flag (pi -m <model>). */
    model?: string;
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
        case "/read": {
            const words = rest.split(/\s+/).filter(Boolean);
            let target = "self";
            let lines = 40;
            if (words[0] && looksLikeTarget(words[0], knownNames)) target = words.shift() as string;
            const n = words[0] !== undefined ? Number(words[0]) : NaN;
            if (Number.isFinite(n) && n > 0) lines = Math.min(Math.floor(n), 80);
            return { kind: "read", target, text: "", lines };
        }
        case "/keys": {
            const words = rest.split(/\s+/).filter(Boolean);
            const target = words[0] && looksLikeTarget(words[0], knownNames) ? (words.shift() as string) : "self";
            return { kind: "keys", target, text: words.join(" ") };
        }
        case "/wait": {
            const words = rest.split(/\s+/).filter(Boolean);
            let target = "self";
            if (words[0] && looksLikeTarget(words[0], knownNames)) target = words.shift() as string;
            const n = words[0] !== undefined ? Number(words[0]) : NaN;
            const timeoutMs = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 600_000) : 300_000;
            return { kind: "wait", target, text: "", timeoutMs };
        }
        case "/agents":
            return { kind: "agents", target: "self", text: "" };
        case "/new": {
            // `/new [@name] [--kind k] [--cwd path] [--model m] <task>` — the
            // optional name needs the @ prefix (bare words are task text:
            // /new fix the tests is ONE task, not agent "fix").
            const words = rest.split(/\s+/).filter(Boolean);
            let agentKind = "pi";
            let cwd: string | undefined;
            let model: string | undefined;
            while (words[0] !== undefined && words[0].startsWith("--")) {
                const flag = words.shift() as string;
                const value = words.shift();
                if (flag === "--kind" && value) agentKind = value;
                else if (flag === "--cwd" && value) cwd = value;
                else if (flag === "--model" && value) model = value;
                // Unknown/missing-value flags are ignored (lenient v1).
            }
            let target = "";
            if (words[0]?.startsWith("@") && words.length > 1) target = (words.shift() as string).slice(1);
            return { kind: "new", target, text: words.join(" "), agentKind, cwd, model };
        }
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
        "<code>/steer [target] &lt;text&gt;</code> — redirect mid-run (target: pane id / agent name)",
        "<code>/followup [target] &lt;text&gt;</code> — queue after current work",
        "<code>/stop [target]</code> — abort the current run",
        "<code>/agents</code> — roster of every agent (attention-sorted)",
        "<code>/read [target] [lines]</code> — read an agent's screen (≤80 lines)",
        "<code>/keys &lt;target&gt; &lt;key&gt;…</code> — esc/enter/up/down/left/right/space/tab · ctrl+c twice",
        "<code>/wait [target] [ms]</code> — wait for idle/done/blocked (default 5 min)",
        "<code>/rc on|off|status</code> — plain-text control toggle",
        "<i>/new — spawn a new agent (M3)</i>",
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

export interface CommandHerdr {
    /** Socket request seam (default: herdrRequest from herdr-socket.ts). */
    request(method: string, params: Record<string, unknown>, options?: HerdrRequestOptions): Promise<import("./herdr-socket.ts").HerdrRequestResult>;
    /** This pane's id (default: $HERDR_PANE_ID). */
    selfPaneId(): string | undefined;
}

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
    /** Herdr socket seam (M2 cross-pane commands). */
    herdr?: CommandHerdr;
    /** Live agent names for target parsing (default: agent.list, 30 s cache). */
    rosterNames?: () => Promise<string[]>;
    /** /new detection poll interval, ms (default 1000; test knob). */
    spawnPollIntervalMs?: number;
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
    const herdr: CommandHerdr =
        deps.herdr ??
        ({
            request: (m, p, o) => herdrRequest(m, p, o),
            selfPaneId: () => process.env.HERDR_PANE_ID,
        } satisfies CommandHerdr);
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
    /** ctrl+c two-tap confirmation window (target → requested-at). */
    let ctrlCPending: { target: string; at: number } | undefined;
    /** agent.name roster cache for parseCommand knownNames (30 s TTL). */
    let rosterCache: { names: string[]; at: number } | undefined;
    /** /new spawn log (timestamps, 1 h window) + auto-name counter. */
    let spawnLog: number[] = [];
    let spawnSeq = 0;
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const pollInterval = deps.spawnPollIntervalMs ?? 1000;

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

    const fetchNames =
        deps.rosterNames ??
        (async (): Promise<string[]> => {
            const r = await herdr.request("agent.list", {}, { timeoutMs: 3000 });
            return r.ok && Array.isArray(r.result.agents)
                ? (r.result.agents as Array<Record<string, unknown>>).map((a) => (typeof a.name === "string" ? a.name : "")).filter(Boolean)
                : [];
        });
    const rosterNames = async (): Promise<string[]> => {
        if (rosterCache && now() - rosterCache.at < 30_000) return rosterCache.names;
        const names = await fetchNames().catch(() => [] as string[]);
        rosterCache = { names, at: now() };
        return names;
    };

    /** Resolve a parsed target to a Herdr socket target string. */
    const resolveTarget = (target: string): { ok: true; target: string } | { ok: false; error: string } => {
        if (target !== "self") return { ok: true, target };
        const pane = herdr.selfPaneId();
        return pane ? { ok: true, target: pane } : { ok: false, error: "this session is not in a Herdr pane — name an explicit target (/agents lists panes)" };
    };

    const execute = (cmd: ParsedCommand): void => {
        // Self-steering (and plain text) stays in-process — first-class
        // steer/followUp semantics via pi.sendUserMessage.
        if ((cmd.kind === "steer" || cmd.kind === "followup" || cmd.kind === "plain") && cmd.target === "self") {
            if (!cmd.text) {
                reply(`✏️ empty ${cmd.kind === "plain" ? "message" : cmd.kind} — nothing sent.`);
                return;
            }
            const mode = cmd.kind === "followup" ? "followUp" : cmd.kind === "steer" ? "steer" : "auto";
            doSend(cmd.text, mode);
            return; // the message itself is the receipt (visible in the TUI transcript)
        }
        // Cross-pane commands run over the Herdr socket; replies land async.
        void executeRemote(cmd);
    };

    const executeRemote = async (cmd: ParsedCommand): Promise<void> => {
        try {
            switch (cmd.kind) {
                case "steer":
                case "followup": {
                    const t = resolveTarget(cmd.target);
                    if (!t.ok) return reply(`✖️ ${t.error}`);
                    if (!cmd.text) return reply("✏️ empty message — nothing sent.");
                    const r = await herdr.request("agent.prompt", { target: t.target, text: cmd.text }, { timeoutMs: 10_000 });
                    if (r.ok) return reply(`→ ${cmd.kind === "followup" ? "queued for" : "steered"} <code>${escapeHtml(t.target)}</code>`);
                    if (r.code === "agent_blocked")
                        return reply(`🔒 <code>${escapeHtml(t.target)}</code> is blocked on a dialog — inspect with <code>/read ${escapeHtml(t.target)}</code>, answer with <code>/keys ${escapeHtml(t.target)} esc|enter|up|down</code>.`);
                    if (r.code === "agent_not_found" || r.code === "agent_not_running")
                        return reply(`✖️ no agent at <code>${escapeHtml(t.target)}</code> — /agents lists live panes.`);
                    return reply(`✖️ steer failed: ${escapeHtml(r.code)} — ${escapeHtml(oneLine(r.message, 160))}`);
                }
                case "stop": {
                    if (cmd.target === "self") {
                        doAbort();
                        reply("⏹ stop requested");
                        return;
                    }
                    const t = resolveTarget(cmd.target);
                    if (!t.ok) return reply(`✖️ ${t.error}`);
                    // pi's interrupt key is Esc (same as the local TUI); best-effort.
                    const r = await herdr.request("agent.send_keys", { target: t.target, keys: ["esc"] }, { timeoutMs: 10_000 });
                    reply(r.ok ? `⏹ interrupt sent to <code>${escapeHtml(t.target)}</code>` : `✖️ ${escapeHtml(r.code)} — ${escapeHtml(oneLine(r.message, 160))}`);
                    return;
                }
                case "read": {
                    const t = resolveTarget(cmd.target);
                    if (!t.ok) return reply(`✖️ ${t.error}`);
                    const lines = Math.min(cmd.lines ?? 40, 80);
                    // pi-family agents render on the alternate screen: only
                    // `visible` returns content (M0 Appendix A); CLI-style
                    // agents answer via recent_unwrapped fallback.
                    let r = await herdr.request("agent.read", { target: t.target, source: "visible", lines, strip_ansi: true }, { timeoutMs: 20_000 });
                    let text = r.ok ? String((r.result.read as Record<string, unknown> | undefined)?.text ?? "") : "";
                    if (r.ok && text.trim().length === 0) {
                        r = await herdr.request("agent.read", { target: t.target, source: "recent_unwrapped", lines, strip_ansi: true }, { timeoutMs: 20_000 });
                        text = r.ok ? String((r.result.read as Record<string, unknown> | undefined)?.text ?? "") : "";
                    }
                    if (!r.ok) {
                        if (r.code === "agent_not_idle") return reply(`⏳ <code>${escapeHtml(t.target)}</code> is busy — /wait ${escapeHtml(t.target)} then retry, or fewer lines.`);
                        return reply(`✖️ read failed: ${escapeHtml(r.code)} — ${escapeHtml(oneLine(r.message, 160))}`);
                    }
                    if (!text.trim()) return reply(`📭 <code>${escapeHtml(t.target)}</code> — screen is empty.`);
                    const clipped = text.length > MAX_MESSAGE_CHARS - 300 ? `…\n${text.slice(-(MAX_MESSAGE_CHARS - 300))}` : text;
                    return void (await sendLong(`📖 <code>${escapeHtml(t.target)}</code> · ${lines} lines\n<pre>${escapeHtml(clipped)}</pre>`));
                }
                case "keys": {
                    const t = resolveTarget(cmd.target);
                    if (!t.ok) return reply(`✖️ ${t.error}`);
                    const keys = cmd.text.split(/\s+/).filter(Boolean).map((k) => (k === "escape" ? "esc" : k));
                    if (keys.length === 0) return reply("✏️ no keys — e.g. <code>/keys wB:p2 esc</code> or <code>/keys wB:p2 up enter</code>.");
                    const allowed = new Set(["esc", "enter", "up", "down", "left", "right", "space", "tab"]);
                    const bad = keys.filter((k) => !allowed.has(k) && k !== "ctrl+c");
                    if (bad.length > 0) return reply(`✖️ unsupported key(s): ${bad.map((k) => `<code>${escapeHtml(k)}</code>`).join(" ")} — allowed: esc enter up down left right space tab (ctrl+c with double confirm).`);
                    if (keys.includes("ctrl+c")) {
                        const pending = ctrlCPending;
                        ctrlCPending = { target: t.target, at: now() };
                        if (!pending || pending.target !== t.target || now() - pending.at > 30_000) {
                            return reply("⚠️ <code>ctrl+c</code> can kill the agent — send the same command again within 30 s to confirm.");
                        }
                        ctrlCPending = undefined;
                    }
                    const r = await herdr.request("agent.send_keys", { target: t.target, keys }, { timeoutMs: 10_000 });
                    reply(r.ok ? `⌨️ sent ${keys.map((k) => `<code>${escapeHtml(k)}</code>`).join(" ")} → <code>${escapeHtml(t.target)}</code>` : `✖️ ${escapeHtml(r.code)} — ${escapeHtml(oneLine(r.message, 160))}`);
                    return;
                }
                case "wait": {
                    const t = resolveTarget(cmd.target);
                    if (!t.ok) return reply(`✖️ ${t.error}`);
                    const timeoutMs = cmd.timeoutMs ?? 300_000;
                    const r = await herdr.request("agent.wait", { target: t.target, until: ["idle", "done", "blocked"], timeout_ms: timeoutMs }, { timeoutMs: timeoutMs + 10_000 });
                    if (r.ok) {
                        const status = String((r.result.agent as Record<string, unknown> | undefined)?.agent_status ?? "idle");
                        return reply(`⌛ <code>${escapeHtml(t.target)}</code> settled: <b>${escapeHtml(status)}</b>`);
                    }
                    if (r.code === "timeout") return reply(`⌛ still not settled after ${Math.round(timeoutMs / 1000)}s — /read ${escapeHtml(t.target)} to peek.`);
                    return reply(`✖️ wait failed: ${escapeHtml(r.code)} — ${escapeHtml(oneLine(r.message, 160))}`);
                }
                case "agents": {
                    const r = await herdr.request("agent.list", {}, { timeoutMs: 5000 });
                    if (!r.ok || !Array.isArray(r.result.agents)) return reply(`✖️ /agents failed: ${escapeHtml(r.ok ? "missing agents array" : r.code)}`);
                    const rows = r.result.agents as HerdrAgentRow[];
                    return void (await sendLong(renderRosterTelegram(hostname(), sortAgents(rows), herdr.selfPaneId())));
                }
                case "new": {
                    if (!cmd.text) {
                        return reply("✏️ usage: <code>/new [@name] [--kind pi|codex|…] [--cwd path] [--model m] &lt;task&gt;</code>");
                    }
                    const self = herdr.selfPaneId();
                    if (!self) return reply("✖️ /new needs this session inside a Herdr pane (it splits a pane beside you).");
                    // Spawn cap: sliding 1 h window (runaway-loop guard).
                    const windowStart = now() - 3_600_000;
                    spawnLog = spawnLog.filter((t) => t >= windowStart);
                    if (spawnLog.length >= 3) {
                        return reply(`✖️ spawn cap reached (${spawnLog.length} in the last hour) — /agents to inspect, or wait a bit.`);
                    }
                    const name = cmd.target || `task-${(spawnSeq += 1)}`;
                    const kind = cmd.agentKind ?? "pi";
                    reply(`⏳ spawning <b>${escapeHtml(name)}</b> (${escapeHtml(kind)})…`);

                    // 1. Split a pane beside this one (cwd flag rides to the child shell).
                    const split = await herdr.request(
                        "pane.split",
                        { target_pane_id: self, direction: "right", focus: false, ratio: 0.34, ...(cmd.cwd ? { cwd: cmd.cwd } : {}) },
                        { timeoutMs: 8000 },
                    );
                    if (!split.ok) return reply(`✖️ pane split failed: ${escapeHtml(split.code)} — ${escapeHtml(oneLine(split.message, 160))}`);
                    const paneId = String((split.result.pane as Record<string, unknown> | undefined)?.pane_id ?? "");
                    if (!paneId) return reply("✖️ pane split response missing pane_id");

                    // 2. Launch the agent (returns launch_pending immediately — M0 Appendix A).
                    // agent_pane_busy = the fresh pane's shell is still initializing
                    // (verified live: split→start race) — brief retries absorb it.
                    let start: Awaited<ReturnType<typeof herdr.request>> = { ok: false, code: "unreached", message: "" };
                    for (let attempt = 0; attempt < 4; attempt++) {
                        start = await herdr.request(
                            "agent.start",
                            { name, kind, pane_id: paneId, args: cmd.model ? ["-m", cmd.model] : [], timeout_ms: 60000 },
                            { timeoutMs: 70_000 },
                        );
                        if (start.ok || start.code !== "agent_pane_busy") break;
                        await sleep(1000 + attempt * 500);
                    }
                    if (!start.ok) {
                        // The agent never launched — closing OUR OWN fresh pane is safe.
                        await herdr.request("pane.close", { pane_id: paneId }, { timeoutMs: 5000 }).catch(() => ({ ok: false }) as const);
                        return reply(`✖️ agent.start failed: ${escapeHtml(start.code)} — ${escapeHtml(oneLine(start.message, 200))} (pane closed)`);
                    }

                    // 3. Poll until detection settles (launch_pending clears, status ≠ unknown).
                    let ready = false;
                    for (let i = 0; i < 90; i++) {
                        const g = await herdr.request("agent.get", { target: name }, { timeoutMs: 4000 });
                        if (g.ok) {
                            const a = (g.result.agent ?? {}) as Record<string, unknown>;
                            if (a.launch_pending !== true && String(a.agent_status ?? "unknown") !== "unknown") {
                                ready = true;
                                break;
                            }
                        }
                        await sleep(pollInterval);
                    }
                    if (!ready) {
                        // Don't close: the agent may still be starting (slow model
                        // list, network) — the pane keeps the partial launch.
                        return reply(`⚠️ ${escapeHtml(name)} not detected within 90 s — pane <code>${escapeHtml(paneId)}</code> kept. Check /read ${escapeHtml(name)} later or inspect the pane.`);
                    }
                    spawnLog.push(now());
                    // The new name must be targetable IMMEDIATELY ("/read <name>"
                    // right after /new) — inject it into the roster cache.
                    rosterCache = { names: [...(rosterCache?.names ?? []), name], at: now() };

                    // 4. Hand it the task.
                    const p = await herdr.request("agent.prompt", { target: name, text: cmd.text }, { timeoutMs: 10_000 });
                    if (!p.ok) {
                        if (p.code === "agent_blocked") {
                            return reply(`🤖 <b>${escapeHtml(name)}</b> is up in <code>${escapeHtml(paneId)}</code> but opened a dialog — /keys ${escapeHtml(name)} to answer.`);
                        }
                        return reply(`🤖 <b>${escapeHtml(name)}</b> is up in <code>${escapeHtml(paneId)}</code> but the task prompt failed (${escapeHtml(p.code)}) — send it with /steer ${escapeHtml(name)} &lt;task&gt;.`);
                    }
                    const extras = [cmd.cwd ? `cwd ${escapeHtml(cmd.cwd)}` : "", cmd.model ? `model ${escapeHtml(cmd.model)}` : ""].filter(Boolean).join(" · ");
                    return void (await reply(
                        `🤖 <b>${escapeHtml(name)}</b> (${escapeHtml(kind)}) live in <code>${escapeHtml(paneId)}</code>${extras ? ` · ${extras}` : ""}\ntrack: /read ${escapeHtml(name)} · steer: /steer ${escapeHtml(name)} &lt;text&gt; · roster: /agents`,
                    ));
                }
                case "help":
                    reply(renderHelp());
                    return;
                case "rc":
                    replyRc(cmd.text);
                    return;
                case "plain":
                    return; // handled in-process by execute()
            }
        } catch (err) {
            reply(`✖️ command failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}`);
        }
    };

    /** Long payloads split at MAX_MESSAGE_CHARS (Telegram limit minus headroom). */
    const sendLong = async (text: string): Promise<void> => {
        const chat = safeChat();
        if (!chat) return;
        if (text.length <= MAX_MESSAGE_CHARS) {
            await chat.client.sendMessage(chat.chatId, text).catch(() => {});
            return;
        }
        for (let i = 0; i < text.length; i += MAX_MESSAGE_CHARS) {
            await chat.client.sendMessage(chat.chatId, text.slice(i, i + MAX_MESSAGE_CHARS)).catch(() => {});
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
            // Claim is decided above (prefix/chat/role only); parsing runs async
            // so the FIRST command already knows the roster's agent names.
            void (async () => {
                await rosterNames();
                const cmd = parseCommand(update.message?.text, rosterCache?.names ?? []);
                if (cmd) execute(cmd);
            })();
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
