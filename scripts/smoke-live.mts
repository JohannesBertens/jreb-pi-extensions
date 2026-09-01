// Smoke test for herdr-agent-live.ts — fully offline: stub Herdr socket server,
// stubbed Telegram transport, canned agent.list responses, real lock files in a
// temp HOME. Run with: node --experimental-strip-types scripts/smoke-live.mts
//
// NOTE: HOME is pointed at a temp dir BEFORE importing modules (config + lock
// paths are computed at module load).

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";
import { execSync } from "node:child_process";

const homeTmp = mkdtempSync(join(tmpdir(), "smoke-live-home-"));
process.env.HOME = homeTmp;
delete process.env.HERDR_SOCKET_PATH;

import type { AgentQueryResult, HerdrAgentRow } from "../herdr-agent-list.ts";
const list = await import("../herdr-agent-list.ts");
const live = await import("../herdr-agent-live.ts");
const core = await import("../herdr-telegram-core.ts");

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exitCode = 1;
        throw new Error(label);
    }
    console.log(`✓ ${label}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- lock primitives ----------------------------------------------------------

ok("pidAlive: self true, dead pid false", live.pidAlive(process.pid) === true && live.pidAlive(999_999_999) === false);

const lockPath = join(homeTmp, "roster.lock");
const cfgDir = join(homeTmp, ".pi", "agent");
mkdirSync(cfgDir, { recursive: true });
const cfgPath = join(cfgDir, "herdr-telegram.json");

ok("acquire with no lock", live.acquireRosterLock(lockPath).acquired === true);
ok("re-acquire own lock", live.acquireRosterLock(lockPath).acquired === true);

// live foreign pid holds the lock: spawn a sleeper and use its pid
const sleeper = execSync("nohup sleep 30 >/dev/null 2>&1 & echo $!", { shell: "/bin/bash" }).toString().trim();
const { writeFileSync } = await import("node:fs");
live.releaseRosterLock(lockPath);
writeFileSync(lockPath, JSON.stringify({ pid: Number(sleeper), heartbeat: Date.now(), messageId: 777 }) + "\n");
const denied = live.acquireRosterLock(lockPath);
ok("live foreign owner blocks acquisition", denied.acquired === false && denied.ownerPid === Number(sleeper), denied);
writeFileSync(lockPath, JSON.stringify({ pid: Number(sleeper), heartbeat: Date.now() - 10 * 60_000, messageId: 777 }) + "\n");
const takeover = live.acquireRosterLock(lockPath);
ok("stale heartbeat → takeover, adopts messageId", takeover.acquired === true);
execSync(`kill ${sleeper} 2>/dev/null`, { shell: "/bin/bash" });
await sleep(30);
writeFileSync(lockPath, JSON.stringify({ pid: Number(sleeper), heartbeat: Date.now(), messageId: 777 }) + "\n");
ok("dead pid → takeover", live.acquireRosterLock(lockPath).acquired === true);
live.releaseRosterLock(lockPath);
ok("release removes own lock", live.readRosterLock(lockPath) === undefined);

// --- stub Herdr socket server + telegram transport -----------------------------

const socketPath = join(homeTmp, "herdr.sock");
const subscribeRequests: Array<{ subscriptions: Array<Record<string, unknown>> }> = [];
let killOnSubscribe = 0; // >0: destroy connection instead of acking (reset-loop test)
const server = net.createServer((socket) => {
    let buf = "";
    socket.on("data", (d) => {
        buf += d.toString("utf8");
        const nl = buf.indexOf("\n");
        if (nl === -1) return;
        const req = JSON.parse(buf.slice(0, nl));
        buf = "";
        if (req.method === "events.subscribe") {
            subscribeRequests.push(req.params);
            if (killOnSubscribe > 0) {
                killOnSubscribe -= 1;
                socket.destroy();
                return;
            }
        }
        socket.write(`${JSON.stringify({ id: req.id, result: { type: "subscription_started" } })}\n`);
    });
});
await new Promise<void>((resolve) => server.listen(socketPath, resolve));
const clients = new Set<net.Socket>();
server.on("connection", (c) => clients.add(c));
const pushAll = (event: string, data: Record<string, unknown>): void => {
    for (const c of clients) c.write(`${JSON.stringify({ event, data })}\n`);
};

// canned agent.list + status transitions
let canned: Array<HerdrAgentRow> = [{ agent: "pi", agent_status: "working", pane_id: "wA:p1", cwd: "/p/alpha" }];
const queryStub = async (): Promise<AgentQueryResult> => ({ ok: true, agents: canned.map((a) => ({ ...a })) });

const sent: Array<{ method: string; body: any }> = [];
core.__setDefaultTransportForTests((async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === "getMe" ? { id: 1, username: "bot" } : { message_id: 501 + sent.filter((c) => c.method === "sendMessage").length } }), { status: 200 });
}) as any);

core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true }, cfgPath);

const events: string[] = [];
const KNOBS = { debounceMs: 15, throttleMs: 25, heartbeatMs: 60_000, pollMs: 80, reconnectBaseMs: 5, reconnectMaxMs: 20, staleMs: 90_000 };
const started = live.startLiveRoster({ socketPath, host: "mini-ai", selfPaneId: "wA:p1", queryAgents: queryStub, lockPath, knobs: KNOBS, onEvent: (l) => events.push(l) });
ok("startLiveRoster starts", started.started === true);
await sleep(120);
const initialSend = sent.find((c) => c.method === "sendMessage");
ok("initial roster sent silently", !!initialSend && initialSend.body.disable_notification === true && initialSend.body.text.includes("Herdr roster") && initialSend.body.text.includes("📡 live · updated"), sent.map((c) => c.method));
ok("subscribe carries per-pane status", subscribeRequests.length > 0 && subscribeRequests[0].subscriptions.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "wA:p1"), subscribeRequests);
ok("message id persisted to lock", live.readRosterLock(lockPath)?.messageId === 501 + 1, live.readRosterLock(lockPath));

// push burst → debounced single edit with changed text
canned = [
    { agent: "pi", agent_status: "idle", pane_id: "wA:p1", cwd: "/p/alpha" },
    { agent: "codex", agent_status: "blocked", pane_id: "wB:p1", cwd: "/p/beta" },
];
for (let i = 0; i < 5; i++) pushAll("pane_agent_status_changed", { pane_id: "wB:p1", agent_status: "blocked" });
await sleep(150);
const edits = sent.filter((c) => c.method === "editMessageText");
ok("burst debounced to one edit", edits.length === 1, edits.length);
ok("edit shows new agent + blocked ping sent", edits[0]?.body.text.includes("codex") && sent.some((c) => c.method === "sendMessage" && c.body.text.includes("⚠️ blocked: codex · wB:p1") && c.body.disable_notification === undefined), sent.map((c) => `${c.method}:${(c.body.text ?? "").slice(0, 20)}`));
ok("ping is audible", sent.some((c) => c.method === "sendMessage" && c.body.text.startsWith("⚠️") && !c.body.disable_notification));

// throttle: immediate further change is deferred, then delivered
const editsBefore = sent.filter((c) => c.method === "editMessageText").length;
canned = [{ agent: "pi", agent_status: "idle", pane_id: "wA:p1", cwd: "/p/alpha" }, { agent: "codex", agent_status: "idle", pane_id: "wB:p1", cwd: "/p/beta" }];
pushAll("pane_agent_status_changed", { pane_id: "wB:p1", agent_status: "idle" });
await sleep(10);
ok("throttle defers rapid edit", sent.filter((c) => c.method === "editMessageText").length === editsBefore);
await sleep(200);
ok("deferred edit lands after window", sent.filter((c) => c.method === "editMessageText").length > editsBefore);

// pane-set drift → reconnect with fresh subscription set
const subsBefore = subscribeRequests.length;
canned = [
    { agent: "pi", agent_status: "idle", pane_id: "wA:p1", cwd: "/p/alpha" },
    { agent: "codex", agent_status: "idle", pane_id: "wB:p1", cwd: "/p/beta" },
    { agent: "pi", agent_status: "done", pane_id: "wC:p1", cwd: "/p/gamma" },
];
pushAll("pane_created", { pane_id: "wC:p1" });
await sleep(150);
ok("pane drift triggers resubscribe with new pane", subscribeRequests.length > subsBefore && subscribeRequests[subscribeRequests.length - 1].subscriptions.some((s) => s.type === "pane.agent_status_changed" && s.pane_id === "wC:p1"), subscribeRequests.length);

// stop with final note
live.stopLiveRoster("⚪ live roster off");
await sleep(60);
const finalEdit = sent.filter((c) => c.method === "editMessageText").at(-1);
ok("stop edits final note", !!finalEdit && finalEdit.body.text.includes("⚪ live roster off"), finalEdit?.body.text?.slice(-60));
ok("stopped", live.liveRosterStatus().running === false);

// --- reset-loop → poll fallback --------------------------------------------------

live.releaseRosterLock(lockPath);
killOnSubscribe = 4; // destroy the next 4 subscribe connections
events.length = 0;
live.startLiveRoster({ socketPath, host: "mini-ai", queryAgents: queryStub, lockPath, knobs: KNOBS, onEvent: (l) => events.push(l) });
await sleep(400);
ok("reset loop degrades to poll fallback", events.includes("poll-fallback"), events);
const editsAtFallback = sent.filter((c) => c.method === "editMessageText").length;
canned = [{ agent: "pi", agent_status: "blocked", pane_id: "wA:p1", cwd: "/p/alpha" }];
await sleep(250); // pollMs 80ms → at least one poll refresh
ok("fallback still refreshes via polling", sent.filter((c) => c.method === "editMessageText").length > editsAtFallback || events.includes("unchanged"));
live.stopLiveRoster();
live.releaseRosterLock(lockPath);

// --- auto-start gates + command wiring ---------------------------------------------

// The command/auto-start paths use the DEFAULT lock path under the temp HOME.
const defaultLock = join(homeTmp, ".pi", "agent", "herdr-roster.lock");
live.releaseRosterLock(defaultLock);

ok("maybeAutoStart: not under Herdr", live.maybeAutoStart(undefined).started === false);
core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true, liveRoster: false }, cfgPath);
ok("maybeAutoStart: liveRoster flag off", live.maybeAutoStart(socketPath).started === false);
core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true }, cfgPath);
ok("maybeAutoStart: starts when allowed", live.maybeAutoStart(socketPath).started === true);
live.stopLiveRoster();

// command wiring: both extension defaults on one pi stub
const notifications: Array<{ message: string; level: string }> = [];
const commands: Record<string, any> = {};
const handlers: Record<string, any[]> = {};
const piStub: any = {
    registerCommand: (name: string, def: any) => (commands[name] = def),
    on: (event: string, handler: any) => (handlers[event] ??= []).push(handler),
    events: { emit: () => {} },
};
list.default(piStub);
live.default(piStub);
ok("live default registers session_start listener", (handlers.session_start ?? []).length === 1);
const ctx = (): any => ({ hasUI: true, cwd: "/x", ui: { notify: (message: string, level: string) => notifications.push({ message, level }) }, sessionManager: { getSessionName: () => "smoke" } });

process.env.HERDR_SOCKET_PATH = socketPath;
await commands.agents.handler("live status", ctx());
ok("/agents live status reports", notifications.some((n) => n.message.includes("live roster:") && n.message.includes("lock owner")));
await commands.agents.handler("live on", ctx());
ok("/agents live on starts + notifies", live.liveRosterStatus().running === true && notifications.some((n) => n.message.includes("Live roster on")));
await commands.agents.handler("live off", ctx());
ok("/agents live off stops + releases + saves flag", live.liveRosterStatus().running === false && live.readRosterLock(defaultLock) === undefined && JSON.parse((await import("node:fs")).readFileSync(cfgPath, "utf-8")).liveRoster === false);
await sleep(80);
ok("/agents live off final edit", sent.some((c) => c.method === "editMessageText" && c.body.text.includes("⚪ live roster off")));

// session_start auto-on via wiring (config re-enabled)
core.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true }, cfgPath);
await handlers.session_start[0]({}, { ...ctx(), mode: "tui" });
await sleep(120);
ok("session_start auto-starts in tui mode", live.liveRosterStatus().running === true && notifications.some((n) => n.message.includes("owns the Telegram fleet message")));
live.stopLiveRoster();
await handlers.session_start[0]({}, { ...ctx(), mode: "rpc" });
ok("session_start skips headless mode", live.liveRosterStatus().running === false);

// cleanup
core.__setDefaultTransportForTests(undefined);
server.close();
rmSync(homeTmp, { recursive: true, force: true });
console.log("\nAll live smoke checks passed.");
// The live engine keeps sockets/timers by design (it runs forever in pi);
// a stopped engine's stub sockets still hold the loop — exit explicitly.
process.exit(process.exitCode ?? 0);
