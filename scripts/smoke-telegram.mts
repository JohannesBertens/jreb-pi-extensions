// Smoke test for herdr-telegram-ask.ts — fully offline via a stubbed transport.
// Run with: node --experimental-strip-types scripts/smoke-telegram.mts
//
// NOTE: HOME is pointed at a temp dir BEFORE importing the module (the config
// path is computed at module load), and the default transport is swapped for a
// fake — no network access happens anywhere in this script.

import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TelegramClient } from "../herdr-telegram-ask.ts";

const homeTmp = mkdtempSync(join(tmpdir(), "smoke-tg-home-"));
process.env.HOME = homeTmp;
process.env.HERDR_ENV = "1";

const mod = await import("../herdr-telegram-ask.ts");

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exitCode = 1;
        throw new Error(label);
    }
    console.log(`✓ ${label}`);
};

// --- fake transport ----------------------------------------------------------
type Call = { url: string; body: any };
const calls: Call[] = [];
let script: ((method: string, body: any) => any) | undefined;

const fakeTransport = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const method = url.split("/").pop() ?? "";
    calls.push({ url, body });
    const result = script ? script(method, body) : { ok: true };
    if (result instanceof Error) return new Response(JSON.stringify({ ok: false, description: result.message }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
};
mod.__setDefaultTransportForTests(fakeTransport as any);

const tick = () => new Promise((r) => setTimeout(r, 10));
const callsOf = (m: string) => calls.filter((c) => c.url.endsWith(`/${m}`));

// --- config -------------------------------------------------------------------
const cfgDir = join(homeTmp, ".pi", "agent");
mkdirSync(cfgDir, { recursive: true });
const cfgPath = join(cfgDir, "herdr-telegram.json");

mod.writeConfigFile({ botToken: "T1", chatId: "42", enabled: true }, cfgPath);
const mode = statSync(cfgPath).mode & 0o777;
ok("config written 0600", mode === 0o600, mode.toString(8));
ok("config round-trips", JSON.parse(readFileSync(cfgPath, "utf-8")).chatId === "42");

ok("env overrides file", mod.loadConfig({ TELEGRAM_BOT_TOKEN: "E", TELEGRAM_CHAT_ID: "7" }, cfgPath).config?.botToken === "E");
ok("file used without env", mod.loadConfig({}, cfgPath).config?.botToken === "T1");
ok("partial env flagged", mod.loadConfig({ TELEGRAM_BOT_TOKEN: "E" }, cfgPath).split === true);
ok("no config anywhere", mod.loadConfig({}, join(homeTmp, "none.json")).config === undefined);

// --- rendering ----------------------------------------------------------------
const msg = mod.renderQuestionnaireMessage({
    args: {
        questions: [
            {
                question: "Deploy <prod> now?",
                header: "Deploy",
                options: [
                    { label: "Yes", description: "ships to production" },
                    { label: "No", description: "keep on staging" },
                ],
            },
            { question: "Which checks?", header: "Checks", multiSelect: true, options: [{ label: "typecheck" }, { label: "smoke" }] },
        ],
    },
    host: "golem",
    project: "jreb-pi-extensions",
    sessionName: "refactor-ask",
    now: new Date("2025-08-29T14:32:00"),
});
for (const expected of [
    "pi needs your input",
    "host:golem · proj:jreb-pi-extensions · session:refactor-ask · since 14:32",
    "[1/2] Deploy &lt;prod&gt; now?",
    "<i>(pick one)</i>",
    "<b>Yes</b> — ships to production",
    "<i>(pick any)</i>",
    "Answer at the terminal",
]) ok(`message contains: ${expected.slice(0, 30)}`, msg.includes(expected), msg);

const huge = mod.renderQuestionnaireMessage({
    args: {
        questions: Array.from({ length: 12 }, (_, i) => ({
            question: `Question ${i} ${"x".repeat(150)}`,
            header: "H",
            options: Array.from({ length: 4 }, (_, j) => ({ label: `opt ${j}`, description: "d".repeat(300) })),
        })),
    },
    host: "h",
    project: "p",
});
ok("huge questionnaire truncated", huge.includes("(truncated") && huge.length < 4200, huge.length);

ok(
    "empty questionnaire fallback",
    mod.renderQuestionnaireMessage({ args: {}, host: "h", project: "p" }).includes("could not be parsed"),
);

// --- answer summary -----------------------------------------------------------
ok(
    "summary from result",
    mod.resolveAnswerSummary({ content: [{ type: "text", text: "User has answered your questions: \"Q\"=\"A\"." }] })?.includes("answered") === true,
);
ok("summary undefined without content", mod.resolveAnswerSummary({}) === undefined);

// --- notifier -----------------------------------------------------------------
const notifications: Array<{ message: string; level: string }> = [];
const sent: Array<{ text: string; messageId: number }> = [];
const edits: Array<{ messageId: number; text: string }> = [];
let nextId = 100;
const fakeClient: TelegramClient = {
    getMe: async () => ({ id: 1, username: "bot" }),
    sendMessage: async (_c, text) => {
        const messageId = ++nextId;
        sent.push({ text, messageId });
        return { message_id: messageId };
    },
    editMessageText: async (_c, messageId, text) => {
        edits.push({ messageId, text });
        return true;
    },
    getUpdates: async () => [],
};
const notifier = mod.createNotifier({
    client: fakeClient,
    chatId: "42",
    notify: (message, level) => notifications.push({ message, level }),
    host: "golem",
});

const stubCtx: any = {
    cwd: "/Users/johannes/projects/jreb-pi-extensions",
    ui: { notify: () => {}, input: async () => undefined },
    sessionManager: { getSessionName: () => "smoke" },
};

notifier.onToolStart({ toolCallId: "x", toolName: "bash", args: {} }, stubCtx);
ok("non-ask tools ignored", sent.length === 0);

notifier.onToolStart({ toolCallId: "q1", toolName: "ask_user_question", args: { questions: [{ question: "Q1?", options: [{ label: "a" }, { label: "b" }] }] } }, stubCtx);
await tick();
ok("question sends one message", sent.length === 1 && sent[0].text.includes("Q1?"));
ok("open count 1", notifier.openCount === 1);

notifier.onToolEnd({ toolCallId: "q1", toolName: "ask_user_question", result: { content: [{ type: "text", text: "User has answered your questions: \"Q1?\"=\"a\"." }] } });
await tick();
ok("resolved edit ✅ with summary", edits.length === 1 && edits[0].text.includes("✅ resolved") && edits[0].text.includes("&quot;Q1?&quot;=&quot;a&quot;") === false && edits[0].text.includes("User has answered"), edits[0]?.text.slice(-200));
ok("open count 0 after end", notifier.openCount === 0);

// duplicate end is a no-op
notifier.onToolEnd({ toolCallId: "q1", toolName: "ask_user_question", result: {} });
await tick();
ok("duplicate end ignored", edits.length === 1);

// error end
notifier.onToolStart({ toolCallId: "q2", toolName: "ask_user_question", args: { questions: [{ question: "Q2?", options: [{ label: "a" }, { label: "b" }] }] } }, stubCtx);
await tick();
notifier.onToolEnd({ toolCallId: "q2", toolName: "ask_user_question", result: {}, isError: true });
await tick();
ok("error end ⚠️", edits.length === 2 && edits[1].text.includes("⚠️ closed with error"));

// drain
notifier.onToolStart({ toolCallId: "q3", toolName: "ask_user_question", args: { questions: [{ question: "Q3?", options: [{ label: "a" }, { label: "b" }] }] } }, stubCtx);
await tick();
notifier.drain();
await tick();
ok("drain edits ⚪ and clears", edits.length === 3 && edits[2].text.includes("⚪ closed without an answer") && notifier.openCount === 0);

// send failure → contained notify, rate-limited
const failing: TelegramClient = {
    ...fakeClient,
    sendMessage: async () => {
        throw new mod.TelegramApiError("sendMessage", "Unauthorized");
    },
};
const failNotifier = mod.createNotifier({ client: failing, chatId: "42", notify: (message, level) => notifications.push({ message, level }) });
failNotifier.onToolStart({ toolCallId: "f1", toolName: "ask_user_question", args: {} }, stubCtx);
await tick();
failNotifier.onToolStart({ toolCallId: "f2", toolName: "ask_user_question", args: {} }, stubCtx);
await tick();
const errNotifies = notifications.filter((n) => n.level === "error");
ok("send failure notified once (rate-limited)", errNotifies.length === 1 && errNotifies[0].message.includes("Unauthorized"), errNotifies);

// early-end race: end arrives while the send is still in flight
let releaseSend: (() => void) | undefined;
const slowClient: TelegramClient = {
    ...fakeClient,
    sendMessage: (_c: string, text: string) =>
        new Promise((resolve) => {
            releaseSend = () => resolve({ message_id: 777 });
            void text;
        }),
};
const raceNotifier = mod.createNotifier({ client: slowClient, chatId: "42", notify: () => {} });
raceNotifier.onToolStart({ toolCallId: "r1", toolName: "ask_user_question", args: {} }, stubCtx);
raceNotifier.onToolEnd({ toolCallId: "r1", toolName: "ask_user_question", result: { content: [{ type: "text", text: "User has answered your questions." }] } });
await tick();
ok("no edit while send in flight", edits.length === 3 || edits.every((e) => e.messageId !== 777));
releaseSend?.();
await tick();
const lateEdit = edits.find((e) => e.messageId === 777);
ok("early end resolved once send lands", !!lateEdit && lateEdit.text.includes("✅ resolved"), edits.map((e) => e.messageId));

// --- extension wiring (default export) ----------------------------------------
const captured: { handlers: Record<string, any[]>; commands: Record<string, any> } = { handlers: {}, commands: {} };
const piStub: any = {
    on: (event: string, handler: any) => (captured.handlers[event] ??= []).push(handler),
    registerCommand: (name: string, def: any) => (captured.commands[name] = def),
};

delete process.env.HERDR_ENV;
mod.default(piStub);
ok("inert without HERDR_ENV", Object.keys(captured.commands).length === 0 && Object.keys(captured.handlers).length === 0);

process.env.HERDR_ENV = "1";
mod.default(piStub);
ok("registers /telegram + handlers", !!captured.commands.telegram && ["tool_execution_start", "tool_execution_end", "agent_end", "session_shutdown"].every((e) => captured.handlers[e]?.length === 1));

const cmdNotifications: string[] = [];
const cmdCtx: any = {
    cwd: "/Users/johannes/projects/jreb-pi-extensions",
    ui: {
        notify: (m: string, _l: string) => cmdNotifications.push(m),
        input: async () => "T1",
    },
    sessionManager: { getSessionName: () => "smoke" },
};

// status reflects the config written earlier in this script (same temp HOME)
await captured.commands.telegram.handler("", cmdCtx);
ok("status reports file config", cmdNotifications.some((m) => m.includes("config: file") && m.includes("enabled: true")));

// write config, notify layer should activate on next tool start
calls.length = 0;
script = (_m, body) => {
    if (_m === "sendMessage") return { message_id: 555 };
    if (_m === "editMessageText") return true;
    return { id: 1, username: "bot" };
};
await captured.handlers.tool_execution_start[0](
    { toolCallId: "w1", toolName: "ask_user_question", args: { questions: [{ question: "Wired?", options: [{ label: "a" }, { label: "b" }] }] } },
    cmdCtx,
);
await tick();
ok("wired notifier sends via stub transport", callsOf("sendMessage").length === 1 && calls[0].url.includes("/botT1/"), calls[0]?.url);
ok("message addressed to configured chat", callsOf("sendMessage")[0].body.chat_id === "42");

await captured.handlers.tool_execution_end[0]({ toolCallId: "w1", toolName: "ask_user_question", result: {} });
await tick();
ok("wired notifier edits ✅", callsOf("editMessageText").length === 1);

// /telegram off → no send; /telegram on → send again
await captured.commands.telegram.handler("off", cmdCtx);
ok("/telegram off writes config", JSON.parse(readFileSync(cfgPath, "utf-8")).enabled === false);
calls.length = 0;
await captured.handlers.tool_execution_start[0]({ toolCallId: "w2", toolName: "ask_user_question", args: {} }, cmdCtx);
await tick();
ok("no send while disabled", callsOf("sendMessage").length === 0);

await captured.commands.telegram.handler("on", cmdCtx);
await captured.handlers.tool_execution_start[0]({ toolCallId: "w3", toolName: "ask_user_question", args: {} }, cmdCtx);
await tick();
ok("send again after on", callsOf("sendMessage").length === 1);

// /telegram test exercises send+edit offline
calls.length = 0;
await captured.commands.telegram.handler("test", cmdCtx);
ok("/telegram test send+edit", callsOf("sendMessage").length === 1 && callsOf("editMessageText").length === 1 && cmdNotifications.some((m) => m.includes("Test message sent")));

// /telegram setup end-to-end with scripted getMe/getUpdates
calls.length = 0;
script = (m) => {
    if (m === "getMe") return { id: 9, username: "smoke_bot" };
    if (m === "getUpdates") return [{ update_id: 5, message: { chat: { id: 42, type: "private" }, text: "/start" } }];
    if (m === "sendMessage") return { message_id: 1 };
    return true;
};
cmdCtx.ui.input = async () => "NEWTOKEN";
await captured.commands.telegram.handler("setup", cmdCtx);
const saved = JSON.parse(readFileSync(cfgPath, "utf-8"));
ok(
    "/telegram setup saves token+chat",
    saved.botToken === "NEWTOKEN" && saved.chatId === "42" && saved.enabled === true && cmdNotifications.some((m) => m.includes("Saved")),
    saved,
);

// cleanup
mod.__setDefaultTransportForTests(undefined);
rmSync(homeTmp, { recursive: true, force: true });
console.log("\nAll telegram smoke checks passed.");
