// Smoke test for herdr-telegram-progress.ts (M2: push-only layer) — fully
// offline via a fake TelegramClient (no transport, no network).
//
// Run: node --experimental-strip-types scripts/smoke-progress.mts

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProgressDeps, RunState } from "../herdr-telegram-progress.ts";

const homeTmp = mkdtempSync(join(tmpdir(), "smoke-tgprog-home-"));
process.env.HOME = homeTmp;

const core = await import("../herdr-telegram-core.ts");
const mod = await import("../herdr-telegram-progress.ts");

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exitCode = 1;
        throw new Error(label);
    }
    console.log(`✓ ${label}`);
};

const flush = () => new Promise((r) => setTimeout(r, 5));

// --- fake client + fake ctx ----------------------------------------------------
interface Sent { text: string; opts?: { disableNotification?: boolean }; markup?: unknown }
interface Edited { messageId: number; text: string; markup?: unknown }
const sent: Sent[] = [];
const edits: Edited[] = [];
let nextMsgId = 100;
let acks: string[] = [];
const callsChat = { chatId: "42" };
let chatLive = true;

const chatOf = () => (chatLive ? { client: fakeClient, chatId: "42" } : undefined);

const fakeClient = {
    getMe: async () => ({ id: 1, username: "bot" }),
    sendMessage: async (_c: string, text: string, markup?: unknown, opts?: { disableNotification?: boolean }) => {
        sent.push({ text, opts, markup });
        return { message_id: ++nextMsgId };
    },
    editMessageText: async (_c: string, messageId: number, text: string, markup?: unknown) => {
        edits.push({ messageId, text, markup });
        return true;
    },
    answerCallbackQuery: async (_id: string, text?: string) => {
        acks.push(text ?? "");
        return true;
    },
    getUpdates: async () => [],
} as any;

const notifications: Array<{ message: string; level: string }> = [];
const fakeCtx: any = {
    cwd: "/Users/johannes/projects/jreb-pi-extensions",
    ui: { notify: (m: string, l: string) => notifications.push({ message: m, level: l }) },
    sessionManager: { getSessionName: () => "plan-tg" },
};

// clock control
let fakeNow = 1_000_000;
const now = () => fakeNow;

const trackerOf = (opts: Partial<ProgressDeps> = {}) =>
    mod.createRunTracker({ getChat: chatOf, enabled: () => true, host: "golem", now, minEditIntervalMs: 10_000, ...opts });

// --- rendering ----------------------------------------------------------------
const baseRun = (over: Partial<RunState> = {}): RunState => ({
    messageId: 7,
    startedAt: 0,
    segments: 1,
    turnCount: 3,
    toolCount: 9,
    errorCount: 0,
    errorPinged: false,
    stopped: false,
    tokensIn: 12_300,
    tokensOut: 4_500,
    costUsd: 0.087,
    lastAssistantLine: "All smoke checks passed.",
    activity: [
        { toolCallId: "a", tool: "bash", summary: "npm run typecheck", startedAt: 0, done: true, error: false },
        { toolCallId: "b", tool: "edit", summary: "herdr-telegram-ask.ts", startedAt: 1000, done: false, error: false },
    ],
    project: "jreb-pi-extensions",
    sessionLabel: "plan-tg",
    settled: false,
    ...over,
});

const runMsg = mod.renderRunMessage(baseRun(), 252_000);
ok("run message header", runMsg.includes("🚀 <b>run · jreb-pi-extensions · plan-tg</b>"));
ok("run message activity done", runMsg.includes("├── ✅ bash · npm run typecheck"));
ok("run message activity running + elapsed", runMsg.includes("└── ⚙️ edit · herdr-telegram-ask.ts · 4m 11s"));
ok("run message status line", runMsg.includes("⏳ turn 3 · 4m 12s · ↑12.3k ↓4.5k tok"));
ok("no activity → no tree", mod.renderRunMessage(baseRun({ activity: [] }), 1000).includes("⏳ turn") && !mod.renderRunMessage(baseRun({ activity: [] }), 1000).includes("├──"));

const many = baseRun({ activity: Array.from({ length: 12 }, (_, i) => ({ toolCallId: `t${i}`, tool: "read", summary: `f${i}.ts`, startedAt: 0, done: true, error: false })) });
const manyMsg = mod.renderRunMessage(many, 1000);
ok("activity truncated with marker", manyMsg.includes("<i>…</i>") && !manyMsg.includes("f3.ts") && manyMsg.includes("f11.ts"), manyMsg);

const settleMsg = mod.renderSettleSummary(baseRun(), 252_000);
ok("settle summary", settleMsg.includes("<b>✅ done · jreb-pi-extensions · plan-tg</b>") && settleMsg.includes("3 turns · 9 tools · 4m 12s") && settleMsg.includes("$0.087") && settleMsg.includes("All smoke checks passed."));
ok("settle summary stopped + errors", mod.renderSettleSummary(baseRun({ stopped: true, errorCount: 2 }), 252_000).includes("⏹ stopped") && mod.renderSettleSummary(baseRun({ stopped: true, errorCount: 2 }), 252_000).includes("2 ⚠️"));
ok("final edit text", mod.renderRunFinal(baseRun({ stopped: true }), 252_000).includes("<b>⏹ stopped · 4m 12s</b>"));

ok("tool summaries", mod.summarizeToolCall("bash", { command: "npm run test" }) === "npm run test" && mod.summarizeToolCall("read", { path: "/a/b/c.ts" }) === "/a/b/c.ts" && mod.summarizeToolCall("grep", { pattern: "x+" }) === "x+" && mod.summarizeToolCall("other", {}) === "");
ok("long command truncated", mod.summarizeToolCall("bash", { command: "x".repeat(200) }).length <= 80);

// --- lifecycle ----------------------------------------------------------------
{
    const t = trackerOf();
    ok("idle tracker: events are no-ops", (t.onTurnStart(0), t.onToolStart({ toolCallId: "x", toolName: "bash", args: {} }), t.onAgentSettled(), true));

    t.onAgentStart(fakeCtx);
    await Promise.resolve();
    ok("run opened: one SILENT message", sent.length === 1 && sent[0].opts?.disableNotification === true, sent[0]);
    ok("run message id recorded", t.openRun?.messageId === 101);

    // second agent_start (retry/compaction) → same run, no new message
    t.onAgentStart(fakeCtx);
    ok("retry segments into same run", sent.length === 1 && t.openRun?.segments === 2);

    t.onTurnStart(0);
    t.onToolStart({ toolCallId: "t1", toolName: "bash", args: { command: "npm run typecheck" } });
    fakeNow += 5_000;
    t.onToolStart({ toolCallId: "t2", toolName: "edit", args: { path: "foo.ts" } });
    // throttled: first tool-start edit went out immediately-ish (>=interval since send), second within interval → queued
    const editsAfterTools = edits.length;
    t.onToolEnd({ toolCallId: "t1", toolName: "bash" });
    ok("tool end within throttle queues trailing edit", edits.length === editsAfterTools);
    fakeNow += 10_001; // trailing timer fires on real clock; emulate by forcing an immediate-eligible edit
    t.onToolStart({ toolCallId: "t3", toolName: "read", args: { path: "bar.ts" } });
    await flush();
    ok("edit lands once interval elapsed", edits.length > editsAfterTools, edits.length);
    const lastEdit = edits[edits.length - 1].text;
    ok("edit shows activity + status", lastEdit.includes("✅ bash · npm run typecheck") && lastEdit.includes("⏳ turn 1"), lastEdit);

    // usage accumulation (two assistant messages; toolResult ignored)
    t.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "working…" }], usage: { input: 1000, output: 500, cost: { total: 0.01 } } });
    t.onMessageEnd({ role: "toolResult", content: [] });
    t.onMessageEnd({ role: "assistant", content: [{ type: "text", text: "final answer" }], usage: { input: 2_000, output: 1_000, cost: { total: 0.02 } } });
    ok("usage accumulated, last line captured", t.openRun?.tokensIn === 3_000 && t.openRun?.tokensOut === 1_500 && t.openRun?.costUsd === 0.03 && t.openRun?.lastAssistantLine === "final answer");

    // settle: audible summary + final edit
    fakeNow += 30_000;
    t.onAgentSettled();
    await flush();
    ok("settle sends AUDIBLE summary", sent.length === 2 && sent[1].opts?.disableNotification !== true && sent[1].text.includes("<b>✅ done"), sent[1]);
    ok("final edit closes run", edits[edits.length - 1].text.includes("<b>✅ done ·"));
    ok("run closed", t.openRun === undefined);
    // events after settle are no-ops
    t.onToolStart({ toolCallId: "t9", toolName: "bash", args: {} });
    t.onAgentSettled();
    ok("post-settle no-ops", sent.length === 2);
}

// --- error ping (once per run) --------------------------------------------------
{
    sent.length = 0;
    edits.length = 0;
    const t = trackerOf();
    t.onAgentStart(fakeCtx);
    await Promise.resolve();
    t.onToolStart({ toolCallId: "e1", toolName: "bash", args: { command: "boom" } });
    t.onToolEnd({ toolCallId: "e1", toolName: "bash", isError: true });
    await flush();
    ok("first error → audible ping", sent.length === 2 && sent[1].text.includes("⚠️") && sent[1].opts?.disableNotification !== true, sent[1]);
    t.onToolEnd({ toolCallId: "e1", toolName: "bash", isError: true });
    await flush();
    ok("second error → no new ping", sent.length === 2 && t.openRun?.errorCount === 2);
    const errEdit = edits.find((e) => e.text.includes("⚠️"));
    ok("error marked in activity", !!errEdit, edits.map((e) => e.text).join("\n---\n"));
    t.onAgentSettled();
    await flush();
    ok("settle after errors mentions count", sent[sent.length - 1].text.includes("2 ⚠️"));
}

// --- gating ---------------------------------------------------------------------
{
    sent.length = 0;
    const t = trackerOf({ enabled: () => false });
    t.onAgentStart(fakeCtx);
    await Promise.resolve();
    ok("disabled → nothing sent", sent.length === 0 && t.openRun === undefined);

    const t2 = trackerOf({ getChat: () => undefined });
    t2.onAgentStart(fakeCtx);
    await Promise.resolve();
    ok("no chat → no run", sent.length === 0 && t2.openRun === undefined);

    // telegram down at open → no run tracking, no crash
    const t3 = trackerOf();
    chatLive = false;
    t3.onAgentStart(fakeCtx);
    await Promise.resolve();
    chatLive = true;
    ok("send failure contained", sent.length === 0 && notifications.length === 0); // rate-limited notify may fire once
}

// --- shutdown orphan cleanup ------------------------------------------------------
{
    sent.length = 0;
    edits.length = 0;
    const t = trackerOf();
    t.onAgentStart(fakeCtx);
    await Promise.resolve();
    t.onShutdown("session ended");
    await flush();
    ok("shutdown final edit ⚪", edits[edits.length - 1].text.includes("⚪ session ended"));
    ok("shutdown closes run", t.openRun === undefined);
}

// --- /progress command + config ----------------------------------------------------
const cfgDir = join(homeTmp, ".pi", "agent");
mkdirSync(cfgDir, { recursive: true });
const cfgPath = join(cfgDir, "herdr-telegram.json");
writeFileSync(cfgPath, JSON.stringify({ botToken: "T1", chatId: "42", enabled: true }));

const captured: { handlers: Record<string, any[]>; commands: Record<string, any> } = { handlers: {}, commands: {} };
const piStub: any = {
    on: (event: string, handler: any) => (captured.handlers[event] ??= []).push(handler),
    registerCommand: (name: string, def: any) => (captured.commands[name] = def),
};
mod.default(piStub);
ok("wires lifecycle handlers", ["agent_start", "turn_start", "tool_execution_start", "tool_execution_end", "message_end", "agent_settled", "session_shutdown", "ui_prompt_start", "ui_prompt_end"].every((e) => captured.handlers[e]?.length === 1));
ok("registers /progress", !!captured.commands.progress);

const cmdNotes: Array<{ message: string; level: string }> = [];
const cmdCtx: any = { ui: { notify: (m: string, l: string) => cmdNotes.push({ message: m, level: l }) } };
await captured.commands.progress.handler("", cmdCtx);
ok("status shows enabled + hub diagnostics", cmdNotes.some((n) => n.message.includes("progress: enabled") && n.message.includes("poll hub:")), cmdNotes);

await captured.commands.progress.handler("off", cmdCtx);
ok("/progress off writes config", JSON.parse(readFileSync(cfgPath, "utf-8")).progress === false);
ok("/progress off announces", cmdNotes.some((n) => n.message.includes("disabled")));
await captured.commands.progress.handler("on", cmdCtx);
ok("/progress on restores", JSON.parse(readFileSync(cfgPath, "utf-8")).progress === true);

// progressEnabled() semantics
ok("progressEnabled default true", core.progressEnabled({}) === true);
ok("progressEnabled config false", core.progressEnabled({}, cfgPath) === false || JSON.parse(readFileSync(cfgPath, "utf-8")).progress === true);
writeFileSync(cfgPath, JSON.stringify({ botToken: "T1", chatId: "42", enabled: true, progress: false }));
ok("progressEnabled false when config.progress=false", core.progressEnabled({}, cfgPath) === false);
ok("progressEnabled env force-off", core.progressEnabled({ TELEGRAM_PROGRESS: "0" }, cfgPath) === false);
writeFileSync(cfgPath, JSON.stringify({ botToken: "T1", chatId: "42", enabled: false, progress: true }));
ok("progressEnabled requires enabled config", core.progressEnabled({}, cfgPath) === false);

// PollHub: subscribe/release lifecycle + claim routing + unclaimed ack
{
    core.__resetSharedPollHubForTests();
    // The loop resolves the chat at subscribe time — have the config ready first
    // (earlier tests left enabled:false on disk).
    writeFileSync(cfgPath, JSON.stringify({ botToken: "T1", chatId: "42", enabled: true }));
    const hub = core.getSharedPollHub();
    ok("hub is a process singleton", core.getSharedPollHub() === hub);
    ok("hub idle", hub.subscriberCount === 0 && hub.polling === false);

    // drive the hub loop through the stubbed transport (stub FIRST — the loop
    // starts at subscribe and would otherwise fire a real getUpdates)
    const updateQueue: any[] = [];
    let acked: string[] = [];
    let nextUid = 5000;
    const calls: string[] = [];
    core.__setDefaultTransportForTests((async (url: string, init?: RequestInit) => {
        const method = url.split("/").pop() ?? "";
        calls.push(method);
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (method === "getUpdates") {
            const out = updateQueue.splice(0);
            return new Response(JSON.stringify({ ok: true, result: out }), { status: 200 });
        }
        if (method === "answerCallbackQuery" && typeof body.callback_query_id === "string") {
            acked.push(body.callback_query_id);
            return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
    }) as any);

    let seen: string[] = [];
    const lease = hub.subscribe((u) => {
        if (u.callback_query?.data?.startsWith("p:")) {
            seen.push(u.callback_query.data);
            return true;
        }
        return false;
    });
    ok("subscribe counted", hub.subscriberCount === 1);

    const cb = (data: string, chatId = 42) => ({ update_id: ++nextUid, callback_query: { id: `id${nextUid}`, data, message: { chat: { id: chatId, type: "private" }, message_id: 1 } } });
    updateQueue.push(cb("p:golem:1:refresh"), cb("deadbeef:0"), cb("p:other:9:stop", 999));
    await new Promise((r) => setTimeout(r, 500));
    ok("claimed p: update", seen.includes("p:golem:1:refresh"), seen);
    ok("unclaimed allowlisted callback acked expired", acked.some((id) => id.startsWith("id")), { acked, seen });
    ok("foreign-chat callback not acked", acked.filter((id) => id === "id" + (nextUid)).length === 0);

    lease.release();
    ok("release empties hub", hub.subscriberCount === 0);
    await new Promise((r) => setTimeout(r, 50));
    ok("hub stops polling after release", hub.polling === false);
    core.__setDefaultTransportForTests(undefined);
}

// --- M3: interactive buttons -------------------------------------------------
{
    sent.length = 0;
    edits.length = 0;
    acks = [];
    const handlers: Array<(u: any) => boolean> = [];
    let subCount = 0;
    const released: number[] = [];
    const fakeHub = {
        subscribe: (h: (u: any) => boolean) => {
            handlers.push(h);
            subCount += 1;
            return { release: () => { subCount -= 1; released.push(subCount); } };
        },
        get subscriberCount() {
            return subCount;
        },
        get polling() {
            return subCount > 0;
        },
    };
    let aborted = 0;
    let todoBranchData: unknown[] = [
        { type: "message", message: { role: "toolResult", toolName: "todo", details: { action: "list", nextId: 5, tasks: [
            { id: 1, subject: "research", status: "completed" },
            { id: 2, subject: "writing tests", activeForm: "writing smoke tests", status: "in_progress" },
            { id: 3, subject: "ship it", status: "pending" },
            { id: 4, subject: "gone", status: "deleted" },
        ] } } },
    ];
    const t = trackerOf({ pollHub: fakeHub as any, abort: () => { aborted += 1; }, getBranch: () => todoBranchData as any, instanceId: "golem:111" });

    t.onAgentStart(fakeCtx);
    await flush();
    ok("open message carries button keyboard", Array.isArray((sent[0].markup as any)?.inline_keyboard) && JSON.stringify(sent[0].markup).includes("⏹ stop"), sent[0].markup);
    ok("tracker subscribes to hub", handlers.length === 1 && fakeHub.subscriberCount === 1);

    let nextU = 77;
    const cbUpdate = (data: string, chatId = 42) => ({ update_id: ++nextU, callback_query: { id: `cb${nextU}`, data, message: { chat: { id: chatId, type: "private" }, message_id: 1 } } });
    const route = (data: string, chatId?: number): boolean => {
        for (const h of handlers) if (h(cbUpdate(data, chatId))) return true;
        return false;
    };

    // refresh: immediate edit bypassing the throttle, edit keeps the keyboard
    const editsBefore = edits.length;
    ok("refresh claimed + acked", route("p:golem:111:refresh") === true && acks[acks.length - 1] === "refreshed");
    await flush();
    ok("refresh edits immediately (throttle bypass)", edits.length > editsBefore && JSON.stringify(edits[edits.length - 1].markup).includes("🔁 refresh"), edits.length);

    // tasks: short list (≤3 live) → inline toast; long list → message with line breaks
    ok("tasks claimed", route("p:golem:111:tasks") === true);
    await flush();
    const tasksAck = acks[acks.length - 1];
    ok("tasks toast renders replay", tasksAck.includes("1 ✔ research") && tasksAck.includes("2 ◐ writing smoke tests") && tasksAck.includes("3 □ ship it") && !tasksAck.includes("gone"), tasksAck);

    // 5 live tasks → message, one task per line
    const sentBeforeTasks = sent.length;
    todoBranchData = [{ type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 6, tasks: [
        { id: 1, subject: "alpha", status: "pending" },
        { id: 2, subject: "beta", status: "pending" },
        { id: 3, subject: "gamma", status: "in_progress", activeForm: "gammating" },
        { id: 4, subject: "delta", status: "completed" },
        { id: 5, subject: "epsilon", status: "pending" },
    ] } } }];
    ok("long tasks claimed", route("p:golem:111:tasks") === true);
    await flush();
    ok("long tasks delivered as message with linebreaks", sent.length === sentBeforeTasks + 1 && sent[sent.length - 1].text.split("\n").some((l) => l.includes("3 ◐ gammating")) && sent[sent.length - 1].text.includes("\n4 ✔ delta\n"), sent[sent.length - 1]);
    ok("long tasks acked", acks[acks.length - 1] === "📋 tasks");

    // stop: abort + stopped flag + ack
    ok("stop claimed + acked", route("p:golem:111:stop") === true && acks[acks.length - 1].includes("stop requested"));
    ok("stop aborts the run", aborted === 1 && t.openRun?.stopped === true);
    await flush();
    ok("stopping state rendered", edits[edits.length - 1].text.includes("⏹ stopping…"), edits[edits.length - 1].text);

    // foreign p: nonce → consumed with owner toast; wizard nonce → passes through
    ok("foreign p: consumed with owner toast", route("p:otherhost:999:stop") === true && acks[acks.length - 1].includes("owned by otherhost"));
    ok("wizard nonce passes through", route("abcdef12:0") === false);
    ok("foreign chat p: not claimed", route("p:golem:111:stop", 999) === false);

    // settle: stopped summary, lease released, stale taps answered
    fakeNow += 5_000;
    t.onAgentSettled();
    await flush();
    ok("stopped settle summary", sent[sent.length - 1].text.includes("⏹ stopped"));
    ok("final edit strips keyboard", edits[edits.length - 1].markup === undefined);
    ok("lease released on settle", fakeHub.subscriberCount === 0 && released.length === 1);
    ok("stale own tap answered", route("p:golem:111:refresh") === true && acks[acks.length - 1] === "no active run");
}

// --- replay / render unit checks ------------------------------------------------
ok("replay last-write-wins", (() => {
    const branch = [
        { type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 3, tasks: [{ id: 1, subject: "old", status: "pending" }] } } },
        { type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 4, tasks: [{ id: 2, subject: "new", status: "in_progress" }] } } },
    ];
    const r = mod.replayTodoState(branch as any);
    return r?.length === 1 && r[0].subject === "new";
})());
ok("replay skips malformed details", (() => {
    const branch = [
        { type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 3, tasks: [{ id: 1, subject: "good", status: "pending" }] } } },
        { type: "message", message: { role: "toolResult", toolName: "todo", details: { tasks: "garbage" } } },
    ];
    const r = mod.replayTodoState(branch as any);
    return r?.length === 1 && r[0].subject === "good";
})());
ok("replay undefined without todo entries", mod.replayTodoState([] as any) === undefined);
ok("render no tasks", mod.renderTodoTasks(undefined) === "No tasks yet" && mod.renderTodoTasks([{ id: 1, subject: "gone", status: "deleted" }]) === "No open tasks" && mod.renderTodoTasks([{ id: 1, subject: "x", status: "completed" }]) === "1 ✔ x");
ok("render inline vs list", mod.renderTodoTasksInline([{ id: 1, subject: "a", status: "pending" }, { id: 2, subject: "b", status: "pending" }]).includes(" · ") && mod.renderTodoTasks([{ id: 1, subject: "a", status: "pending" }, { id: 2, subject: "b", status: "pending" }]).includes("\n"));
ok("long task list goes to a message, not a toast", mod.renderTodoTasksInline(Array.from({ length: 8 }, (_, i) => ({ id: i, subject: `subject-${i}-padpadpadpad`, status: "pending" }))).length > 190);

// --- M4: dialog pings ----------------------------------------------------------
{
    sent.length = 0;
    edits.length = 0;
    acks = [];
    const t = trackerOf();

    // idle (no run) → no ping (walk-away heuristic: command/setup input is terminal-local)
    t.onUIPromptStart("input", "Bot token");
    t.onUIPromptEnd();
    ok("idle dialog → no ping", sent.length === 0);

    // mid-run foreign dialog → audible ping + ✅ edit on resolve
    t.onAgentStart(fakeCtx);
    await flush();
    const sentBefore = sent.length;
    t.onUIPromptStart("confirm", "Run destructive command?");
    await flush();
    ok("mid-run dialog pings audibly", sent.length === sentBefore + 1 && sent[sent.length - 1].text.includes("pi is blocked on a dialog") && sent[sent.length - 1].text.includes("confirm") && sent[sent.length - 1].opts?.disableNotification !== true);
    t.onUIPromptEnd();
    await flush();
    ok("dialog resolved edit", edits[edits.length - 1].text.includes("✅ resolved"));

    // ask_user_question active → suppressed (wizard owns messaging)
    t.onToolStart({ toolCallId: "q1", toolName: "ask_user_question", args: {} });
    t.onUIPromptStart("select", "Deploy?");
    t.onUIPromptEnd();
    t.onToolEnd({ toolCallId: "q1", toolName: "ask_user_question" });
    ok("ask dialog suppressed", sent.length === sentBefore + 1);

    // consecutive dialog within PING_REOPEN_MS reuses the resolved message
    const editsBefore = edits.length;
    t.onUIPromptStart("select", "Next one?");
    await flush();
    ok("ping reused via edit, not new send", sent.length === sentBefore + 1 && edits.length === editsBefore + 1 && edits[edits.length - 1].text.includes("Next one?"));
    // nested span does not double-ping; end of outer span resolves
    t.onUIPromptStart("input", "nested");
    t.onUIPromptEnd();
    ok("nested span ignored", sent.length === sentBefore + 1);
    t.onUIPromptEnd();
    await flush();
    ok("outer span resolves", edits[edits.length - 1].text.includes("✅ resolved"));

    // stale reuse (>PING_REOPEN_MS) sends a fresh audible ping
    fakeNow += mod.PING_REOPEN_MS + 1;
    t.onUIPromptStart("confirm", "Much later?");
    await flush();
    ok("stale reuse sends new ping", sent.length === sentBefore + 2 && sent[sent.length - 1].text.includes("Much later?"));
    t.onAgentSettled();
    await flush();
    ok("settle resolves open dialog ping", edits[edits.length - 2].text.includes("run ended"));
}

rmSync(homeTmp, { recursive: true, force: true });
console.log("\nAll progress smoke checks passed.");
