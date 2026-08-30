/**
 * herdr-agent-list — `/agents`: roster of every recognized agent in the LOCAL
 * Herdr instance, read directly from Herdr's Unix-socket API.
 *
 * Talks the same newline-framed JSON-RPC the Herdr-managed pi integration uses
 * (write direction there, read direction here):
 *   → {"id","method":"agent.list","params":{}}
 *   ← {"id","result":{"type":"agent_list","agents":[…]}}
 * Verified against herdr 0.8.2 / protocol 20 — see the research note
 * (jreb-memory: research/herdr-multi-instance.md) and plan
 * (jreb-memory: plans/herdr-agent-list.md).
 *
 * Scope (decisions locked 2026-08-30): local Herdr only — Herdr has no
 * cross-machine discovery, and a multi-PC SSH fan-out is deliberately deferred.
 * Output: TUI notify + best-effort Telegram push when the bridge is configured
 * (config is re-read per call, so /telegram off is respected immediately).
 *
 * Zero runtime dependencies: node:net / node:os / node:path / node:fs only, plus
 * the shared Telegram plumbing from herdr-telegram-core.ts. The socket factory is
 * injectable so scripts/smoke-agents.mts runs fully offline.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { escapeHtml, getChat, oneLine } from "./herdr-telegram-core.ts";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { createConnection, type Socket } from "node:net";

// ---------------------------------------------------------------------------
// Socket read (agent.list)
// ---------------------------------------------------------------------------

export interface HerdrAgentRow {
    agent: string;
    agent_status: string;
    cwd?: string;
    pane_id: string;
    workspace_id?: string;
    tab_id?: string;
    terminal_id?: string;
    terminal_title?: string;
    focused?: boolean;
}

export type AgentQueryResult = { ok: true; agents: HerdrAgentRow[] } | { ok: false; error: string };

export type SocketFactory = (socketPath: string) => Socket;

let socketFactory: SocketFactory = (socketPath) => createConnection(socketPath);

/** Test hook: swap the socket constructor (scripts/smoke-agents.mts). */
export function __setHerdrSocketFactoryForTests(factory: SocketFactory | undefined): void {
    socketFactory = factory ?? ((socketPath) => createConnection(socketPath));
}

/** $HERDR_SOCKET_PATH when set; else the default socket if it exists; else undefined. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (typeof env.HERDR_SOCKET_PATH === "string" && env.HERDR_SOCKET_PATH.length > 0) {
        return env.HERDR_SOCKET_PATH;
    }
    const fallback = join(env.HOME ?? "~", ".config", "herdr", "herdr.sock");
    return existsSync(fallback) ? fallback : undefined;
}

/**
 * One-shot `agent.list` over the Herdr socket: connect, write one request line,
 * parse the first response line, destroy. Never rejects — failures are typed
 * results so the command handler stays throw-free.
 */
export function queryHerdrAgents(socketPath: string, timeoutMs = 2000): Promise<AgentQueryResult> {
    return new Promise((resolve) => {
        let settled = false;
        let buffer = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (result: AgentQueryResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try {
                socket.destroy();
            } catch {
                /* already gone */
            }
            resolve(result);
        };
        const socket = socketFactory(socketPath);
        timer = setTimeout(() => done({ ok: false, error: "Herdr socket timed out" }), timeoutMs);
        timer.unref?.();
        socket.on("error", (err: Error) => done({ ok: false, error: `Herdr socket unreachable (${err.message})` }));
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ id: `pi:agents:${Date.now()}`, method: "agent.list", params: {} })}\n`);
        });
        socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const newline = buffer.indexOf("\n");
            if (newline === -1) return; // partial line — wait for more
            const line = buffer.slice(0, newline).trim();
            let message: { error?: { code?: string; message?: string }; result?: { agents?: unknown } };
            try {
                message = JSON.parse(line);
            } catch {
                done({ ok: false, error: `unexpected Herdr response: ${oneLine(line, 120)}` });
                return;
            }
            if (message.error) {
                done({ ok: false, error: `Herdr error ${message.error.code ?? "unknown"}: ${message.error.message ?? "no message"}` });
                return;
            }
            const agents = message.result?.agents;
            if (!Array.isArray(agents)) {
                done({ ok: false, error: "Herdr response missing agents array" });
                return;
            }
            done({ ok: true, agents: agents as HerdrAgentRow[] });
        });
        socket.on("end", () => {
            if (!settled && buffer.trim().length === 0) done({ ok: false, error: "Herdr socket closed before answering" });
        });
    });
}

// ---------------------------------------------------------------------------
// Roster shaping
// ---------------------------------------------------------------------------

const STATE_ORDER: Record<string, number> = { blocked: 0, working: 1, done: 2, idle: 3, unknown: 4 };
const STATE_GLYPH: Record<string, string> = { blocked: "●", working: "◐", done: "✓", idle: "·", unknown: "?" };

/** Attention-sorted copy: blocked → working → done → idle → unknown, then pane_id. */
export function sortAgents(agents: HerdrAgentRow[]): HerdrAgentRow[] {
    return [...agents].sort(
        (a, b) =>
            (STATE_ORDER[a.agent_status] ?? 4) - (STATE_ORDER[b.agent_status] ?? 4) ||
            String(a.pane_id).localeCompare(String(b.pane_id)),
    );
}

export function stateGlyph(status: string): string {
    return STATE_GLYPH[status] ?? "?";
}

function rosterCounts(agents: HerdrAgentRow[]): string {
    const blocked = agents.filter((a) => a.agent_status === "blocked").length;
    const working = agents.filter((a) => a.agent_status === "working").length;
    let counts = `${agents.length} agent${agents.length === 1 ? "" : "s"}`;
    if (blocked > 0) counts += ` · ${blocked} blocked`;
    if (working > 0) counts += ` · ${working} working`;
    return counts;
}

/** cwd label: basename, unless another row shares that basename → full path. */
function cwdLabels(agents: HerdrAgentRow[]): string[] {
    const basenames = agents.map((a) => (typeof a.cwd === "string" && a.cwd.length > 0 ? basename(a.cwd) : ""));
    return agents.map((a, i) => {
        if (basenames[i] === "") return "(no cwd)";
        return basenames.filter((b, j) => b === basenames[i] && j !== i).length > 0 ? String(a.cwd) : basenames[i];
    });
}

function rosterLine(agent: HerdrAgentRow, cwd: string, kindWidth: number, selfPaneId?: string): string {
    const marks: string[] = [];
    if (agent.focused) marks.push("(focused)");
    if (selfPaneId && agent.pane_id === selfPaneId) marks.push("← you");
    return `  ${stateGlyph(agent.agent_status)} ${agent.agent_status.padEnd(8)} ${agent.agent.padEnd(kindWidth)} ${cwd}  ${agent.pane_id}${marks.length ? ` ${marks.join(" ")}` : ""}`;
}

export function renderRosterTui(host: string, agents: HerdrAgentRow[], selfPaneId?: string): string {
    if (agents.length === 0) {
        return `${host} — Herdr roster · 0 agents (no recognized agents in any pane)`;
    }
    const labels = cwdLabels(agents);
    const kindWidth = Math.max(...agents.map((a) => a.agent.length));
    const lines = [`${host} — Herdr roster · ${rosterCounts(agents)}`];
    for (let i = 0; i < agents.length; i++) {
        lines.push(rosterLine(agents[i], labels[i], kindWidth, selfPaneId));
    }
    return lines.join("\n");
}

export function renderRosterTelegram(host: string, agents: HerdrAgentRow[], selfPaneId?: string): string {
    if (agents.length === 0) {
        return `🖥 <b>${escapeHtml(host)}</b> — Herdr roster · 0 agents (no recognized agents in any pane)`;
    }
    const labels = cwdLabels(agents);
    const lines = [`🖥 <b>${escapeHtml(host)}</b> — Herdr roster · ${rosterCounts(agents)}`];
    for (let i = 0; i < agents.length; i++) {
        const agent = agents[i];
        const marks: string[] = [];
        if (agent.focused) marks.push("(focused)");
        if (selfPaneId && agent.pane_id === selfPaneId) marks.push("← you");
        lines.push(
            `${stateGlyph(agent.agent_status)} <b>${escapeHtml(agent.agent)}</b> <i>${escapeHtml(agent.agent_status)}</i> ` +
                `${escapeHtml(labels[i])} · <code>${escapeHtml(agent.pane_id)}</code>${marks.length ? ` ${escapeHtml(marks.join(" "))}` : ""}`,
        );
    }
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const NOT_UNDER_HERDR = "not running under Herdr — start pi inside a Herdr pane (no HERDR_SOCKET_PATH and no default socket found)";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("agents", {
        description: "List all recognized agents in the local Herdr instance (attention-sorted roster)",
        handler: async (_args: string, ctx: ExtensionContext) => {
            const socketPath = herdrSocketPath();
            if (!socketPath) {
                ctx.ui.notify(NOT_UNDER_HERDR, "error");
                return;
            }
            const host = hostname();
            const query = await queryHerdrAgents(socketPath);
            if (!query.ok) {
                ctx.ui.notify(`${query.error} — check \`herdr status\``, "error");
                return;
            }
            const agents = sortAgents(query.agents);
            const selfPaneId = process.env.HERDR_PANE_ID;
            ctx.ui.notify(renderRosterTui(host, agents, selfPaneId), "info");

            // Best-effort Telegram push — never blocks or fails the TUI output.
            // getChat() re-reads the config per call, so /telegram off is honored.
            const chat = getChat();
            if (!chat) return;
            try {
                await chat.client.sendMessage(chat.chatId, renderRosterTelegram(host, agents, selfPaneId));
            } catch (err) {
                ctx.ui.notify(`Telegram push failed: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
        },
    });
}
