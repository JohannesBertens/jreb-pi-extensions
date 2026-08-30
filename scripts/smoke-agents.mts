// Smoke test for herdr-agent-list.ts — fully offline: a stub Unix-socket server
// plays Herdr, and the Telegram transport is faked via the core test hook.
// Run with: node --experimental-strip-types scripts/smoke-agents.mts
//
// NOTE: HOME is pointed at a temp dir BEFORE importing the module (the Telegram
// config path is computed at module load), and the stub server lives on a real
// socket path in that temp dir so the default createConnection factory is used.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import type { HerdrAgentRow } from "../herdr-agent-list.ts";

const homeTmp = mkdtempSync(join(tmpdir(), "smoke-agents-home-"));
process.env.HOME = homeTmp;
delete process.env.HERDR_SOCKET_PATH;

const mod = await import("../herdr-agent-list.ts");
const core = await import("../herdr-telegram-core.ts");

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exitCode = 1;
        throw new Error(label);
    }
    console.log(`✓ ${label}`);
};

// --- stub Herdr server --------------------------------------------------------

const receivedLines: string[] = [];
let cannedResponse: string | null = null;
const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        receivedLines.push(buf.slice(0, nl));
        buf = "";
        if (cannedResponse !== null) socket.write(`${cannedResponse}\n`);
        // cannedResponse === null: silent server (timeout path)
    });
});
const socketPath = join(homeTmp, "herdr.sock");
await new Promise<void>((resolve) => server.listen(socketPath, resolve));
const setCanned = (result: unknown, error?: { code: string; message: string }): void => {
    cannedResponse = JSON.stringify({ id: "stub", ...(error ? { error } : { result }) });
};

const mkAgent = (agent: string, status: string, pane_id: string, extra: Partial<HerdrAgentRow> = {}): HerdrAgentRow => ({
    agent,
    agent_status: status,
    pane_id,
    cwd: `/home/johannes/projects/${agent}-project`,
    ...extra,
});

// --- query + protocol shape ---------------------------------------------------

setCanned({ type: "agent_list", agents: [mkAgent("pi", "working", "wA:p1")] });
const q = await mod.queryHerdrAgents(socketPath, 1000);
ok("query parses agents", q.ok && q.agents.length === 1 && q.agents[0].agent === "pi", q);
ok(
    "request envelope is agent.list",
    receivedLines.length > 0 &&
        (() => {
            const r = JSON.parse(receivedLines[receivedLines.length - 1]);
            return r.method === "agent.list" && JSON.stringify(r.params) === "{}" && typeof r.id === "string";
        })(),
    receivedLines,
);

setCanned(undefined, { code: "invalid_request", message: "nope" });
const qErr = await mod.queryHerdrAgents(socketPath, 1000);
ok("error envelope surfaces", !qErr.ok && qErr.error.includes("invalid_request") && qErr.error.includes("nope"), qErr);

setCanned({ type: "agent_list" }); // missing agents array
const qMissing = await mod.queryHerdrAgents(socketPath, 1000);
ok("missing agents array detected", !qMissing.ok && qMissing.error.includes("missing agents array"), qMissing);

const qUnreachable = await mod.queryHerdrAgents(join(homeTmp, "nope.sock"), 500);
ok("unreachable socket errors cleanly", !qUnreachable.ok && qUnreachable.error.includes("unreachable"), qUnreachable);

cannedResponse = null; // silent server
const qTimeout = await mod.queryHerdrAgents(socketPath, 60);
ok("silent server times out", !qTimeout.ok && qTimeout.error.includes("timed out"), qTimeout);

// --- sorting + rendering ------------------------------------------------------

const mixed = [
    mkAgent("codex", "idle", "wB:p2"),
    mkAgent("pi", "working", "wA:p2"),
    mkAgent("pi", "blocked", "wC:p1"),
    mkAgent("claude", "unknown", "wB:p1"),
    mkAgent("pi", "done", "wA:p3"),
    mkAgent("pi", "working", "wA:p1"),
];
const sorted = mod.sortAgents(mixed);
ok(
    "attention sort + pane tiebreak",
    sorted.map((a) => `${a.agent_status}:${a.pane_id}`).join(" ") === "blocked:wC:p1 working:wA:p1 working:wA:p2 done:wA:p3 idle:wB:p2 unknown:wB:p1",
    sorted.map((a) => `${a.agent_status}:${a.pane_id}`),
);

const tui = mod.renderRosterTui("mini-ai", sorted, "wA:p1");
// Three pi rows share the "pi-project" basename → full paths; codex/claude stay basename-only.
for (const expected of [
    "mini-ai — Herdr roster · 6 agents · 1 blocked · 2 working",
    "● blocked  pi     /home/johannes/projects/pi-project  wC:p1",
    "◐ working  pi     /home/johannes/projects/pi-project  wA:p1 ← you",
    "✓ done     pi     /home/johannes/projects/pi-project  wA:p3",
    "· idle     codex  codex-project",
    "? unknown  claude claude-project",
]) ok(`tui contains: ${expected.slice(0, 30)}`, tui.includes(expected), tui);

// cwd ambiguity → full path; unique basename → basename
const ambiguous = [mkAgent("pi", "idle", "wA:p1", { cwd: "/a/alpha/app" }), mkAgent("codex", "idle", "wA:p2", { cwd: "/b/beta/app" })];
const ambiguousTui = mod.renderRosterTui("h", ambiguous);
ok("ambiguous cwd basename → full paths", ambiguousTui.includes("/a/alpha/app") && ambiguousTui.includes("/b/beta/app"), ambiguousTui);
const distinct = [mkAgent("pi", "idle", "wA:p1", { cwd: "/a/alpha/one" }), mkAgent("codex", "idle", "wA:p2", { cwd: "/b/beta/two" })];
const distinctTui = mod.renderRosterTui("h", distinct);
ok("distinct cwd → basenames only", distinctTui.includes(" one ") && distinctTui.includes(" two ") && !distinctTui.includes("/a/"), distinctTui);

ok("empty roster message", mod.renderRosterTui("h", []).includes("0 agents (no recognized agents in any pane)"));
const tg = mod.renderRosterTelegram("mini<ai>", sorted.slice(0, 2), "wA:p1");
ok("telegram render escapes + marks", tg.includes("🖥 <b>mini&lt;ai&gt;</b>") && tg.includes("<code>wA:p1</code>") && tg.includes("← you") && tg.includes("<i>blocked</i>"), tg);

// --- command wiring -----------------------------------------------------------

const notifications: Array<{ message: string; level: string }> = [];
const commands: Record<string, any> = {};
const piStub: any = { registerCommand: (name: string, def: any) => (commands[name] = def), events: { emit: () => {} } };
mod.default(piStub);
ok("registers /agents", !!commands.agents && typeof commands.agents.handler === "function");

const ctx = (): any => ({
    hasUI: true,
    cwd: "/x",
    ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    sessionManager: { getSessionName: () => "smoke" },
});

// not under Herdr: no env socket, no default socket in temp HOME
delete process.env.HERDR_SOCKET_PATH;
await commands.agents.handler("", ctx());
ok("not-under-herdr error", notifications.some((n) => n.level === "error" && n.message.includes("not running under Herdr")));

// happy path + telegram push (enabled)
const cfgDir = join(homeTmp, ".pi", "agent");
mkdirSync(cfgDir, { recursive: true });
const cfgPath = join(cfgDir, "herdr-telegram.json");
core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true }, cfgPath);
const sent: Array<{ method: string; body: any }> = [];
core.__setDefaultTransportForTests((async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { id: 1, username: "bot" } : { message_id: 1 } }), { status: 200 });
}) as any);

process.env.HERDR_SOCKET_PATH = socketPath;
process.env.HERDR_PANE_ID = "wA:p1";
setCanned({ type: "agent_list", agents: [mkAgent("pi", "blocked", "wA:p1", { focused: true }), mkAgent("pi", "working", "wB:p1")] });
notifications.length = 0;
await commands.agents.handler("", ctx());
ok("roster notified to tui", notifications.some((n) => n.level === "info" && n.message.includes("Herdr roster") && n.message.includes("● blocked")));
ok("telegram push fired once", sent.filter((c) => c.method === "sendMessage").length === 1 && sent[0].body.text.includes("Herdr roster") && sent[0].body.chat_id === "42", sent.map((c) => c.method));
ok("telegram roster is html", sent[0].body.parse_mode === "HTML" && sent[0].body.text.includes("<code>wA:p1</code>"));

// telegram disabled → no push
core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: false }, cfgPath);
sent.length = 0;
notifications.length = 0;
await commands.agents.handler("", ctx());
ok("disabled config → no push", sent.filter((c) => c.method === "sendMessage").length === 0 && notifications.some((n) => n.level === "info"));

// telegram configured but send fails → roster still notified + warning
core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true }, cfgPath);
core.__setDefaultTransportForTests((async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 400 });
}) as any);
notifications.length = 0;
await commands.agents.handler("", ctx());
ok("push failure warns but roster shows", notifications.some((n) => n.level === "info" && n.message.includes("Herdr roster")) && notifications.some((n) => n.level === "error" && n.message.includes("Telegram push failed")));

// socket dies mid-flight (server stopped) → clean error
server.close();
await new Promise((r) => setTimeout(r, 20));
notifications.length = 0;
await commands.agents.handler("", ctx());
ok("server-down error surfaces", notifications.some((n) => n.level === "error" && n.message.includes("unreachable") && n.message.includes("herdr status")));

// cleanup
core.__setDefaultTransportForTests(undefined);
rmSync(homeTmp, { recursive: true, force: true });
console.log("\nAll agents smoke checks passed.");
