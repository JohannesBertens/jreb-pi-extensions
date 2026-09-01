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
import { herdrRequest, herdrSocketPath as resolveSocketPath } from "./herdr-socket.ts";
import { hostname } from "node:os";
import { basename } from "node:path";

// Re-exported for back-compat (scripts/smoke-agents.mts and any external use).
export { __setHerdrSocketFactoryForTests, herdrSocketPath } from "./herdr-socket.ts";
export type { SocketFactory } from "./herdr-socket.ts";

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

/**
 * One-shot `agent.list` over the Herdr socket (delegates to herdr-socket.ts).
 * Never rejects — failures are typed results so the command handler stays
 * throw-free.
 */
export async function queryHerdrAgents(socketPath: string, timeoutMs = 2000): Promise<AgentQueryResult> {
    const r = await herdrRequest("agent.list", {}, { socketPath, timeoutMs });
    if (!r.ok) {
        const error =
            r.code === "timeout"
                ? "Herdr socket timed out"
                : r.code === "unreachable"
                  ? r.message
                  : r.code === "bad_response"
                    ? r.message
                    : r.code === "closed"
                      ? "Herdr socket closed before answering"
                      : `Herdr error ${r.code}: ${r.message}`;
        return { ok: false, error };
    }
    const agents = r.result.agents;
    if (!Array.isArray(agents)) {
        return { ok: false, error: "Herdr response missing agents array" };
    }
    return { ok: true, agents: agents as HerdrAgentRow[] };
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

/** Best-effort callback for the `live` subcommand — set by herdr-agent-live.ts
 *  at load (dependency direction: live → list, never the reverse).
 *
 *  Cross-copy safety: pi evaluates every extension file with its own jiti
 *  instance (moduleCache: false — see herdr-telegram-core.ts header + spike
 *  scripts/spike-jiti-singleton.mts), so herdr-agent-live.ts's import of this
 *  file is a DIFFERENT module copy than the one pi evaluates as the extension.
 *  Module-level state would silently split — the registration MUST live on
 *  globalThis behind Symbol.for, same pattern as the PollHub. */
export type LiveCommandHandler = (sub: string, ctx: ExtensionContext) => void | Promise<void>;
const LIVE_HANDLER_KEY = Symbol.for("herdr-agent-list.liveHandler");
export function registerLiveHandler(handler: LiveCommandHandler | undefined): void {
    (globalThis as typeof globalThis & { [LIVE_HANDLER_KEY]?: LiveCommandHandler })[LIVE_HANDLER_KEY] = handler;
}
function liveHandler(): LiveCommandHandler | undefined {
    return (globalThis as typeof globalThis & { [LIVE_HANDLER_KEY]?: LiveCommandHandler })[LIVE_HANDLER_KEY];
}

const NOT_UNDER_HERDR = "not running under Herdr — start pi inside a Herdr pane (no HERDR_SOCKET_PATH and no default socket found)";

export default function (pi: ExtensionAPI) {
    pi.registerCommand("agents", {
        description: "List all recognized agents in the local Herdr instance (attention-sorted roster); `live` subcommand for the Telegram fleet message",
        handler: async (args: string, ctx: ExtensionContext) => {
            const words = args.trim().split(/\s+/).filter(Boolean);
            if (words[0]?.toLowerCase() === "live") {
                const handler = liveHandler();
                if (!handler) {
                    ctx.ui.notify("live roster module not loaded — is herdr-agent-live.ts installed?", "error");
                    return;
                }
                await handler(words[1]?.toLowerCase() ?? "", ctx);
                return;
            }
            const socketPath = resolveSocketPath();
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
