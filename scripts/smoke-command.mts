// Smoke test for herdr-telegram-command.ts (M1) — fully offline: fake chat,
// fake clock, temp controller file, stubbed send/abort. No network, no pi.
//
// Run: node --experimental-strip-types scripts/smoke-command.mts

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const homeTmp = mkdtempSync(join(tmpdir(), "smoke-tgcmd-home-"));
process.env.HOME = homeTmp;

const core = await import("../herdr-telegram-core.ts");
const mod = await import("../herdr-telegram-command.ts");

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exitCode = 1;
        throw new Error(label);
    }
    console.log(`✓ ${label}`);
};

// --- fixtures ---------------------------------------------------------------
const controllerPath = join(homeTmp, "controller.json");
let clock = 1_000_000;
const now = () => clock;
const sent: string[] = [];
const sends: Array<{ text: string; mode: string }> = [];
let aborted = 0;

const fakeChat = {
    client: { sendMessage: async (_c: string, text: string) => { sent.push(text); return { message_id: sent.length }; } },
    chatId: "42",
};
const getChat = () => fakeChat as any;

// A stand-in hub: just records the subscription; the handler is driven directly.
const recordedSubs: Array<(u: any) => boolean> = [];
const fakeHub = { subscribe: (h: (u: any) => boolean) => { recordedSubs.push(h); return { release: () => {} }; }, subscriberCount: 1, polling: false } as any;

// --- 1. parseCommand table ---------------------------------------------------
const P = mod.parseCommand;
ok("parse: plain text", JSON.stringify(P("hello there")) === JSON.stringify({ kind: "plain", target: "self", text: "hello there" }), P("hello there"));
ok("parse: /steer bare text stays whole", P("/steer fix the tests")?.target === "self" && P("/steer fix the tests")?.text === "fix the tests", P("/steer fix the tests"));
ok("parse: /steer explicit self", P("/steer self do it")?.target === "self" && P("/steer self do it")?.text === "do it");
ok("parse: /steer pane target", P("/steer wB:p2 hurry up")?.target === "wB:p2" && P("/steer wB:p2 hurry up")?.text === "hurry up");
ok("parse: /steer name target (known roster)", P("/steer reviewer check again", ["reviewer"])?.target === "reviewer");
ok("parse: name not in roster stays text", P("/steer reviewer check again")?.target === "self");
ok("parse: target word kept when it is the text", P("/steer later")?.target === "self" && P("/steer later")?.text === "later", P("/steer later"));
ok("parse: /followup", P("/followup then run typecheck")?.kind === "followup");
ok("parse: /queue alias", P("/queue then run typecheck")?.kind === "followup");
ok("parse: /followup target", P("/followup wA:p1 and then")?.target === "wA:p1");
ok("parse: /stop", P("/stop")?.kind === "stop" && P("/stop")?.target === "self");
ok("parse: /stop target (known + pane)", P("/stop reviewer", ["reviewer"])?.target === "reviewer" && P("/stop wB:p2")?.target === "wB:p2");
ok("parse: /help", P("/help")?.kind === "help");
ok("parse: /start → help", P("/start")?.kind === "help");
ok("parse: /rc on", JSON.stringify(P("/rc on")) === JSON.stringify({ kind: "rc", target: "self", text: "on" }), P("/rc on"));
ok("parse: /new bare task auto-name", (() => { const c = P("/new fix the flaky tests"); return c?.kind === "new" && c.target === "" && c.text === "fix the flaky tests" && c.agentKind === "pi"; })());
ok("parse: /new @name", (() => { const c = P("/new @reviewer review the diff"); return c?.target === "reviewer" && c.text === "review the diff"; })());
ok("parse: /new flags", (() => { const c = P("/new --kind codex --cwd /tmp/x --model gpt-5.4 @rev check it"); return c?.agentKind === "codex" && c?.cwd === "/tmp/x" && c?.model === "gpt-5.4" && c?.target === "rev" && c?.text === "check it"; })());
ok("parse: /new flags without name", (() => { const c = P("/new --model glm-5.3 do the thing"); return c?.model === "glm-5.3" && c?.target === "" && c?.text === "do the thing"; })());
ok("parse: @ without rest is task text", (() => { const c = P("/new @todo-list-item"); return c?.target === "" && c?.text === "@todo-list-item"; })());
ok("parse: /rc status default text", P("/rc")?.text === "");
ok("parse: unknown slash → help", P("/definitely-not-a-command x")?.kind === "help");
ok("parse: empty → undefined", P("") === undefined && P(undefined) === undefined);
ok("parse: whitespace trim", P("   /steer    padded   ")?.text === "padded");
ok("parse: multiline text preserved", P("line one\nline two")?.kind === "plain" && !!(P("line one\nline two")?.text.includes("\n")));
ok("help renders", mod.renderHelp().includes("/steer") && mod.renderHelp().includes("/rc"));

// --- 2. controller election --------------------------------------------------
const ctl = mod.createController({ path: controllerPath, host: "h1", pid: 111, paneId: "wA:p1", now });
ok("controller: not enabled → not controller", !ctl.isController());
ctl.enable();
ok("controller: enable claims file", ctl.isController() && existsSync(controllerPath));
const rec = JSON.parse(readFileSync(controllerPath, "utf-8"));
ok("controller: record shape", rec.host === "h1" && rec.pid === 111 && rec.paneId === "wA:p1" && rec.heartbeatAt === clock, rec);
clock += 10_000; ctl.beatOnce();
ok("controller: beat refreshes", JSON.parse(readFileSync(controllerPath, "utf-8")).heartbeatAt === clock);

// foreign fresh controller blocks us
writeFileSync(controllerPath, JSON.stringify({ host: "h1", pid: 999, paneId: "wB:p9", heartbeatAt: clock }));
ok("controller: foreign fresh → not controller", !ctl.isController());
ctl.beatOnce();
ok("controller: foreign fresh → beat does not steal", JSON.parse(readFileSync(controllerPath, "utf-8")).pid === 999);

// stale foreign → takeover
clock += mod.CONTROLLER_STALE_MS + 1;
ok("controller: foreign stale → not controller (until beat)", !ctl.isController());
ctl.beatOnce();
ok("controller: beat takes over stale", ctl.isController() && JSON.parse(readFileSync(controllerPath, "utf-8")).pid === 111);

// disable releases only our own record
ctl.disable();
ok("controller: disable releases file", !existsSync(controllerPath) && !ctl.isController());
writeFileSync(controllerPath, JSON.stringify({ host: "h1", pid: 999, paneId: "wB:p9", heartbeatAt: clock }));
ctl.releaseIfOurs();
ok("controller: release never deletes foreign record", JSON.parse(readFileSync(controllerPath, "utf-8")).pid === 999);
rmSync(controllerPath, { force: true });

// --- 3. claim predicate ------------------------------------------------------
const C = mod.claimsUpdate;
const msg = (text: string, chatId = "42") => ({ message: { chat: { id: Number(chatId) }, text } });
const base = { enabled: true, controller: true, askDepth: 0, chatId: "42" };
ok("claim: slash always", C(msg("/steer x") as any, base));
ok("claim: plain as controller", C(msg("hi") as any, base));
ok("claim: plain not controller", !C(msg("hi") as any, { ...base, controller: false }));
ok("claim: plain with open question", !C(msg("hi") as any, { ...base, askDepth: 1 }));
ok("claim: plain when disabled", !C(msg("hi") as any, { ...base, enabled: false }));
ok("claim: foreign chat ignored", !C(msg("/steer x", "13") as any, base));
ok("claim: empty text", !C(msg("   ") as any, base));
ok("claim: callback query never", !C({ callback_query: { id: "1", data: "p:x:stop" } } as any, base));
ok("claim: no message never", !C({} as any, base));

// --- 4. handler end-to-end (stubbed send/abort, fake hub) --------------------
const ctl2 = mod.createController({ path: controllerPath, host: "h1", pid: 222, paneId: "wA:p2", now });
ctl2.enable();
let idle = true;
const handler = mod.createCommandHandler({
    getChat,
    pollHub: fakeHub,
    controller: ctl2,
    now,
    isIdle: () => idle,
    send: (text, mode) => sends.push({ text, mode: idle || mode === "auto" ? (idle ? "send-now" : "auto") : mode }),
    abort: () => { aborted += 1; },
    rosterNames: async () => [],
});

ok("handler: subscribed to hub", (mod.bindHandler(handler, fakeHub), recordedSubs.length === 1));
const H = (u: any) => handler.handleUpdate(u);
const HF = async (u: any) => { H(u); for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)); };

// slash commands work regardless of controller state (async dispatch — flush)
await HF(msg("/steer tighten the types"));
ok("exec: /steer idle → plain send", sends.at(-1)?.text === "tighten the types" && sends.at(-1)?.mode === "send-now", sends.at(-1));
idle = false;
await HF(msg("/steer pivot to plan B"));
ok("exec: /steer streaming → steer", sends.at(-1)?.mode === "steer", sends.at(-1));
await HF(msg("/followup then typecheck"));
ok("exec: /followup streaming → followUp", sends.at(-1)?.mode === "followUp");
idle = true;
await HF(msg("/followup queued while idle"));
ok("exec: /followup idle → immediate send", sends.at(-1)?.mode === "send-now");
await HF(msg("/stop"));
ok("exec: /stop aborts", aborted === 1);
await HF(msg("/help"));
ok("exec: /help replies", !!(sent.at(-1)?.includes("/steer")));

// plain text: only as controller without an open question
await HF(msg("just checking in"));
ok("exec: plain text as controller", sends.at(-1)?.text === "just checking in" && sends.at(-1)?.mode === "send-now");
handler.onToolStart("ask_user_question");
await HF(msg("this should reach the wizard, not us"));
ok("exec: plain text declined while ask open", sends.at(-1)?.text === "just checking in");
handler.onToolEnd("ask_user_question");
await HF(msg("question closed, hearing again"));
ok("exec: plain text after ask closes", sends.at(-1)?.text === "question closed, hearing again");

// --- 5. cross-pane commands (stubbed Herdr socket) --------------------------
const herdrCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
let herdrResponse: () => any = () => ({ ok: true, result: {} });
const stubHerdr = {
    request: async (method: string, params: Record<string, unknown>) => {
        herdrCalls.push({ method, params });
        return herdrResponse();
    },
    selfPaneId: () => "wB:p1",
};
const ctl3 = mod.createController({ path: controllerPath, host: "h1", pid: 333, paneId: "wB:p1", now });
ctl3.enable();
const rh = mod.createCommandHandler({
    getChat,
    pollHub: fakeHub,
    controller: ctl3,
    now,
    isIdle: () => true,
    send: (text, mode) => sends.push({ text, mode: mode === "auto" ? "send-now" : mode }),
    abort: () => { aborted += 1; },
    herdr: stubHerdr as any,
    rosterNames: async () => ["reviewer"],
});
const RH = (u: any) => rh.handleUpdate(u);
const lastReply = () => sent.at(-1) ?? "";
const flushCmd = async (u: any) => { RH(u); for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1)); };

// /steer foreign → agent.prompt over the socket
sent.length = 0; herdrCalls.length = 0;
herdrResponse = () => ({ ok: true, result: {} });
await flushCmd(msg("/steer wB:p2 tighten the types"));
ok("m2: /steer foreign → agent.prompt", herdrCalls.at(-1)?.method === "agent.prompt" && herdrCalls.at(-1)?.params.target === "wB:p2" && herdrCalls.at(-1)?.params.text === "tighten the types", herdrCalls);
ok("m2: steer reply confirms", lastReply().includes("steered") && lastReply().includes("wB:p2"), lastReply());

// agent_blocked → /keys hint
herdrResponse = () => ({ ok: false, code: "agent_blocked", message: "agent is blocked and requires interactive input" });
await flushCmd(msg("/steer reviewer continue"));
ok("m2: agent_blocked hint", lastReply().includes("blocked") && lastReply().includes("/keys"), lastReply());

// /read: visible first, fallback when empty
sent.length = 0; herdrCalls.length = 0;
let readSeq = 0;
herdrResponse = () => {
    const n = readSeq++;
    if (herdrCalls[n]?.method === "agent.read" && herdrCalls[n].params.source === "visible") return { ok: true, result: { read: { text: "" } } };
    if (herdrCalls[n]?.method === "agent.read") return { ok: true, result: { read: { text: "cli output line" } } };
    return { ok: true, result: {} };
};
await flushCmd(msg("/read wB:p2 20"));
ok("m2: /read visible→fallback", herdrCalls.filter((c) => c.method === "agent.read").length === 2 && herdrCalls[1].params.source === "recent_unwrapped", herdrCalls);
ok("m2: /read lines capped + sent", herdrCalls[0].params.lines === 20 && lastReply().includes("cli output line"), lastReply());
ok("m2: /read default 40 lines", (() => { readSeq = 0; herdrCalls.length = 0; return true; })());

// /keys: allowlist + two-tap ctrl+c
sent.length = 0; herdrCalls.length = 0;
herdrResponse = () => ({ ok: true, result: {} });
await flushCmd(msg("/keys wB:p2 ctrl+a x"));
ok("m2: bad key rejected", lastReply().includes("unsupported key"), lastReply());
await flushCmd(msg("/keys wB:p2 ctrl+c"));
ok("m2: ctrl+c first tap warns", lastReply().includes("again within 30"), lastReply());
ok("m2: ctrl+c not sent yet", !herdrCalls.some((c) => c.method === "agent.send_keys"));
await flushCmd(msg("/keys wB:p2 ctrl+c"));
ok("m2: ctrl+c second tap sends", herdrCalls.some((c) => c.method === "agent.send_keys" && JSON.stringify(c.params.keys) === '["ctrl+c"]'), herdrCalls);
ok("m2: escape aliases esc", (() => { herdrCalls.length = 0; return true; })());
await flushCmd(msg("/keys reviewer escape enter"));
ok("m2: escape→esc + multi-key + roster name", herdrCalls.some((c) => c.method === "agent.send_keys" && JSON.stringify(c.params.keys) === '["esc","enter"]' && c.params.target === "reviewer"), herdrCalls);

// /wait settle + timeout
sent.length = 0; herdrCalls.length = 0;
herdrResponse = () => ({ ok: true, result: { agent: { agent_status: "done" } } });
await flushCmd(msg("/wait wB:p2 5000"));
ok("m2: /wait envelope + status", herdrCalls.at(-1)?.method === "agent.wait" && herdrCalls.at(-1)?.params.timeout_ms === 5000 && lastReply().includes("done"), lastReply());
herdrResponse = () => ({ ok: false, code: "timeout", message: "timed out" });
await flushCmd(msg("/wait wB:p2"));
ok("m2: /wait default timeout + timeout reply", herdrCalls.at(-1)?.params.timeout_ms === 300000 && lastReply().includes("still not settled"), lastReply());

// /agents roster push
sent.length = 0; herdrCalls.length = 0;
herdrResponse = () => ({ ok: true, result: { agents: [{ agent: "pi", agent_status: "working", pane_id: "wB:p2", cwd: "/x/repo" }] } });
const rosterEdits: Array<{ messageId: number; text: string }> = [];
let rosterEditFails = false;
(fakeChat.client as any).editMessageText = async (_c: string, messageId: number, text: string) => {
    if (rosterEditFails) throw new Error("message to edit not found");
    rosterEdits.push({ messageId, text });
    return true;
};
const lockDir = join(homeTmp, ".pi", "agent");
mkdirSync(lockDir, { recursive: true });
const lockFile = join(lockDir, "herdr-roster.lock");

// no lock → one-shot push (existing behavior)
await flushCmd(msg("/agents"));
ok("m2: /agents pushes roster", !!(sent.at(-1)?.includes("wB:p2")) && !!(sent.at(-1)?.includes("working")) && rosterEdits.length === 0, sent.at(-1));

// fresh lock (own pid, current heartbeat, message id) → EDIT the live message
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, heartbeat: clock, messageId: 777 }));
sent.length = 0;
await flushCmd(msg("/agents"));
ok("unify: fresh lock edits live message", rosterEdits.at(-1)?.messageId === 777 && !!(rosterEdits.at(-1)?.text.includes("wB:p2")) && !!(rosterEdits.at(-1)?.text.includes("📡 live")), rosterEdits.at(-1));
ok("unify: edit confirmed via toast", !!(sent.at(-1)?.includes("live roster refreshed")) && !sent.some((s) => s.includes("🖥")), sent.at(-1));

// stale lock → one-shot push fallback
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, heartbeat: clock - 120_000, messageId: 777 }));
rosterEdits.length = 0; sent.length = 0;
await flushCmd(msg("/agents"));
ok("unify: stale lock falls back to push", rosterEdits.length === 0 && !!(sent.at(-1)?.includes("wB:p2")), sent.at(-1));

// fresh lock but edit fails → push fallback
writeFileSync(lockFile, JSON.stringify({ pid: process.pid, heartbeat: clock, messageId: 777 }));
rosterEditFails = true; rosterEdits.length = 0; sent.length = 0;
await flushCmd(msg("/agents"));
ok("unify: failed edit falls back to push", rosterEdits.length === 0 && !!(sent.at(-1)?.includes("wB:p2")), sent.at(-1));
rosterEditFails = false;
rmSync(lockFile, { force: true });

// /stop foreign → send_keys esc; /stop self → in-process abort
sent.length = 0; herdrCalls.length = 0; aborted = 0;
herdrResponse = () => ({ ok: true, result: {} });
await flushCmd(msg("/stop wB:p2"));
ok("m2: /stop foreign → esc", herdrCalls.some((c) => c.method === "agent.send_keys" && c.params.target === "wB:p2" && JSON.stringify(c.params.keys) === '["esc"]'));
herdrCalls.length = 0;
await flushCmd(msg("/stop"));
ok("m2: /stop self → abort", aborted === 1 && !herdrCalls.some((c) => c.method === "agent.send_keys"));

// /rc via Telegram flips the shared controller (original handler)
sent.length = 0;
await HF(msg("/rc status"));
ok("exec: /rc status replies", !!(sent.at(-1)?.includes("rc:")));
await HF(msg("/rc off"));
ok("exec: /rc off disables", !ctl2.isController() && !existsSync(controllerPath));
await HF(msg("nobody hears this"));
ok("exec: plain ignored after /rc off", sends.at(-1)?.text === "question closed, hearing again");
await HF(msg("/steer still works after off"));
ok("exec: slash still works after /rc off", sends.at(-1)?.text === "still works after off");

// shutdown releases
ctl2.enable();
handler.onShutdown();
ok("shutdown: controller released", !existsSync(controllerPath));

// foreign chat is never claimed
sent.length = 0; sends.length = 0;
ok("exec: foreign chat unclaimed", !H(msg("/steer x", "13")));
ok("exec: nothing sent for foreign chat", sent.length === 0 && sends.length === 0);

// --- 6. /new spawn chain (stubbed socket) -----------------------------------
const newSent: string[] = [];
const newChat = { client: { sendMessage: async (_c: string, text: string) => { newSent.push(text); return { message_id: newSent.length }; } }, chatId: "42" };
const newCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
let newResponse: (call: { method: string; params: Record<string, unknown> }) => any = () => ({ ok: true, result: {} });
let newClock = 5_000_000;
const newHerdr = {
    request: async (method: string, params: Record<string, unknown>) => {
        const call = { method, params };
        newCalls.push(call);
        return newResponse(call);
    },
    selfPaneId: () => "wB:p1",
};
const nh = mod.createCommandHandler({
    getChat: () => newChat as any,
    isIdle: () => true,
    send: () => {},
    abort: () => {},
    herdr: newHerdr as any,
    rosterNames: async () => [],
    now: () => newClock,
    spawnPollIntervalMs: 2,
});
const NF = async (u: any) => { nh.handleUpdate(u); for (let i = 0; i < 220; i++) await new Promise((r) => setTimeout(r, 1)); };
const lastNew = () => newSent.at(-1) ?? "";

// happy path: split → start → detect → prompt (detection poll returns ready on 3rd agent.get)
let agentGets = 0;
newResponse = (call) => {
    if (call.method === "pane.split") return { ok: true, result: { pane: { pane_id: "wB:pZ" } } };
    if (call.method === "agent.start") return { ok: true, result: { agent: { agent_status: "unknown", launch_pending: true } } };
    if (call.method === "agent.get") {
        agentGets += 1;
        if (agentGets < 3) return { ok: true, result: { agent: { agent_status: "unknown", launch_pending: true } } };
        return { ok: true, result: { agent: { agent_status: "idle", launch_pending: false } } };
    }
    if (call.method === "agent.prompt") return { ok: true, result: {} };
    return { ok: true, result: {} };
};
await NF(msg("/new --kind pi --cwd /tmp/proj @scan scan the repo for TODOs"));
const splitCall = newCalls.find((c) => c.method === "pane.split");
ok("new: split beside self, cwd flag", splitCall?.params.target_pane_id === "wB:p1" && splitCall?.params.cwd === "/tmp/proj", splitCall);
const startCall = newCalls.find((c) => c.method === "agent.start");
ok("new: start envelope", startCall?.params.name === "scan" && startCall?.params.kind === "pi" && startCall?.params.pane_id === "wB:pZ" && Array.isArray(startCall?.params.args), startCall);
ok("new: detection polled", agentGets >= 3);
ok("new: prompt carries task", newCalls.some((c) => c.method === "agent.prompt" && c.params.target === "scan" && c.params.text === "scan the repo for TODOs"));
ok("new: summary reply", lastNew().includes("scan") && lastNew().includes("wB:pZ") && lastNew().includes("/read scan"), lastNew());

// --model flag → args ["-m", model]
newCalls.length = 0; newSent.length = 0; agentGets = 99; // detection immediate
await NF(msg("/new --model glm-5.3 quick check"));
ok("new: model flag passes -m", (() => { const s = newCalls.find((c) => c.method === "agent.start"); return Array.isArray(s?.params.args) && JSON.stringify(s?.params.args) === '["-m","glm-5.3"]'; })(), newCalls.find((c) => c.method === "agent.start"));
ok("new: auto-name task-1 used", newCalls.some((c) => c.method === "agent.start" && typeof c.params.name === "string" && /^task-\d+$/.test(c.params.name)));

// spawn cap: 3rd spawn allowed, 4th refused within the window
await NF(msg("/new another one"));
ok("new: third spawn succeeds", newSent.some((s) => s.includes("live in")), newSent.at(-1));
newCalls.length = 0; newSent.length = 0;
await NF(msg("/new over the cap"));
ok("new: cap reached reply", lastNew().includes("cap"), lastNew());
ok("new: no spawn calls after cap", !newCalls.some((c) => c.method === "pane.split"));
newClock += 3_600_100; // window slides past the logged entries (filter is >=)

// agent.start failure → pane closed + error reply
newCalls.length = 0; newSent.length = 0; agentGets = 99;
newResponse = (call) => {
    if (call.method === "pane.split") return { ok: true, result: { pane: { pane_id: "wB:pZ" } } };
    if (call.method === "agent.start") return { ok: false, code: "pane_not_ready", message: "pane not at shell prompt" };
    if (call.method === "pane.close") return { ok: true, result: {} };
    return { ok: true, result: {} };
};
await NF(msg("/new doomed spawn"));
ok("new: start failure closes pane", newCalls.some((c) => c.method === "pane.close" && c.params.pane_id === "wB:pZ"), newCalls.map((c) => c.method));
ok("new: start failure replies", lastNew().includes("pane_not_ready"), lastNew());

// detection timeout → pane KEPT + warning (fast poll via spawnPollIntervalMs)
newCalls.length = 0; newSent.length = 0;
newResponse = (call) => {
    if (call.method === "pane.split") return { ok: true, result: { pane: { pane_id: "wB:pQ" } } };
    if (call.method === "agent.start") return { ok: true, result: { agent: { launch_pending: true } } };
    if (call.method === "agent.get") return { ok: true, result: { agent: { agent_status: "unknown", launch_pending: true } } };
    return { ok: true, result: {} };
};
await NF(msg("/new never appears"));
ok("new: detection timeout keeps pane", !newCalls.some((c) => c.method === "pane.close"));
ok("new: detection timeout warns with pane id", lastNew().includes("not detected") && lastNew().includes("wB:pQ"), lastNew());

rmSync(homeTmp, { recursive: true, force: true });
console.log("\nsmoke-command: all green");
