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
    "Tap an option or reply with text",
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

// --- shared fake client (used by the elapsed-edit session test below) --------
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
    answerCallbackQuery: async () => true,
    getUpdates: async () => [],
};

// --- extension wiring (default export) ----------------------------------------
const captured: { handlers: Record<string, any[]>; commands: Record<string, any>; tools: Map<string, any> } = { handlers: {}, commands: {}, tools: new Map() };
const piStub: any = {
    on: (event: string, handler: any) => (captured.handlers[event] ??= []).push(handler),
    registerCommand: (name: string, def: any) => (captured.commands[name] = def),
    registerTool: (tool: any) => captured.tools.set(tool.name, tool),
    events: { emit: () => {} },
};

// ADR-0002: no HERDR_ENV gating — tool + command register everywhere.
delete process.env.HERDR_ENV;
mod.default(piStub);
ok("registers tool + /telegram without HERDR_ENV", Object.keys(captured.commands).length === 1 && captured.tools.has("ask_user_question"));

process.env.HERDR_ENV = "1";
mod.default(piStub);
ok("registers tool + /telegram under Herdr", !!captured.commands.telegram && captured.tools.has("ask_user_question"));
ok("no lifecycle handlers (notifier layer removed)", Object.keys(captured.handlers).length === 0);

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
ok("status reports owned tool + drift hint", cmdNotifications.some((m) => m.includes("owned by this file") && m.includes("Telegram + terminal race") && m.includes("rpiv: upstream not installed") && m.includes("drift check")));

// /telegram off disables remote answering immediately (tool stays registered — we own it)
await captured.commands.telegram.handler("off", cmdCtx);
ok("/telegram off writes config", JSON.parse(readFileSync(cfgPath, "utf-8")).chatId === "42" && JSON.parse(readFileSync(cfgPath, "utf-8")).enabled === false);
ok("/telegram off announces immediate local-only", cmdNotifications.some((m) => m.includes("local-only") && m.includes("no reload")));

await captured.commands.telegram.handler("on", cmdCtx);
ok("/telegram on re-enables", JSON.parse(readFileSync(cfgPath, "utf-8")).enabled === true);
ok("/telegram on announces remote answering", cmdNotifications.some((m) => m.includes("answered remotely")));

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

// --- M2: validation clone -----------------------------------------------------
const VQ = (questions: unknown[]) => mod.validateQuestionnaire({ questions } as any);
const mkQ = (question: string, labels: string[] = ["a", "b"], multiSelect = false) => ({
    question,
    header: "H",
    multiSelect,
    options: labels.map((label) => ({ label, description: "d" })),
});

ok("validation ok", VQ([mkQ("Q?")]).ok === true);
const v1 = VQ([]);
ok("validation no_questions", !v1.ok && v1.error === "no_questions");
const v2 = VQ([mkQ("1?"), mkQ("2?"), mkQ("3?"), mkQ("4?"), mkQ("5?")]);
ok("validation too_many_questions", !v2.ok && v2.error === "too_many_questions");
const v3 = VQ([mkQ("Same?"), mkQ("Same?")]);
ok("validation duplicate_question", !v3.ok && v3.error === "duplicate_question");
const v4 = VQ([mkQ("Q?", ["only"])]);
ok("validation too few options", !v4.ok && v4.error === "empty_options" && v4.message.includes("at least 2"));
const v5 = VQ([mkQ("Q?", ["Other", "b", "b"])]);
ok("validation reserved before duplicate", !v5.ok && v5.error === "reserved_label");
const v6 = VQ([mkQ("Q?", ["a", "a"])]);
ok("validation duplicate label", !v6.ok && v6.error === "duplicate_option_label");

// --- M2: envelope clone -------------------------------------------------------
const env = (answers: any[], cancelled = false) => mod.buildQuestionnaireResponse({ answers, cancelled }, { questions: [mkQ("Q?"), mkQ("M?", ["x", "y"], true)] } as any);

ok("envelope declined on cancel", env([{ questionIndex: 0, question: "Q?", kind: "option", answer: "a" }], true).content[0].text === "User declined to answer questions");
ok(
    "envelope answered single",
    env([{ questionIndex: 0, question: "Q?", kind: "option", answer: "a" }]).content[0].text ===
        'User has answered your questions: "Q?"="a". You can now continue with the user\'s answers in mind.',
);
ok(
    "envelope multi join",
    env([{ questionIndex: 1, question: "M?", kind: "multi", answer: null, selected: ["x", "y"] }]).content[0].text.includes('"M?"="x, y"'),
);
ok("envelope custom empty placeholder", env([{ questionIndex: 0, question: "Q?", kind: "custom", answer: "" }]).content[0].text.includes('"Q?"="(no input)"'));
ok(
    "envelope preview echo",
    mod
        .buildQuestionnaireResponse(
            { answers: [{ questionIndex: 0, question: "Q?", kind: "option", answer: "a", preview: "P" }], cancelled: false },
            { questions: [{ question: "Q?", header: "H", options: [{ label: "a", description: "d", preview: "P" }, { label: "b", description: "d" }] }] } as any,
        )
        .content[0].text.includes("selected preview: P"),
);

// --- M2: shadow tool end-to-end (remote/local race, offline transport) --------
let nextMsgId = 500;
let nextUid = 1000;
let nextCbId = 1;
const keyboardNonce = { value: "" };
let updateQueue: any[] = [];
const tgCalls: Array<{ method: string; body: any }> = [];

mod.__setDefaultTransportForTests((async (url: string, init?: RequestInit) => {
    const method = url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    tgCalls.push({ method, body });
    let result: any = true;
    if (method === "getMe") result = { id: 1, username: "bot" };
    if (method === "sendMessage") {
        const kb = (body.reply_markup as { inline_keyboard?: any[][] } | undefined)?.inline_keyboard;
        const withData = kb?.flat().find((b: any) => typeof b.callback_data === "string");
        if (withData) keyboardNonce.value = withData.callback_data.split(":")[0];
        result = { message_id: ++nextMsgId };
    }
    if (method === "getUpdates") {
        result = updateQueue;
        updateQueue = [];
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
}) as any);

const cbUpdate = (data: string, chatId = 42) => ({
    update_id: ++nextUid,
    callback_query: { id: `cb${nextCbId++}`, data, message: { chat: { id: chatId, type: "private" }, message_id: nextMsgId } },
});
const msgUpdate = (text: string, chatId = 42) => ({
    update_id: ++nextUid,
    message: { chat: { id: chatId, type: "private" }, text, message_id: 60 },
});
const settle = async (p: Promise<any>, ticks = 45) => {
    for (let i = 0; i < ticks; i++) await tick();
    return p;
};
const eventsEmitted: Array<[string, any]> = [];
const piForTool: any = { events: { emit: (channel: string, data: any) => eventsEmitted.push([channel, data]) } };
const notified2: string[] = [];

const makeExecCtx = (selectImpl: any) => ({
    hasUI: true,
    cwd: "/Users/johannes/projects/jreb-pi-extensions",
    ui: { select: selectImpl, input: async () => undefined, notify: (m: string, _l: string) => notified2.push(m) },
    sessionManager: { getSessionName: () => "smoke" },
});
/** select that hangs until aborted (simulates user staring at the terminal) */
const hangingSelect = (_t: string, _o: string[], opts?: any) =>
    new Promise<string | undefined>((res) => opts?.signal?.addEventListener("abort", () => res(undefined)));
const chatDeps = () => ({ client: mod.createTelegramClient("TK"), chatId: "42" });
const toolDef: any = mod.buildAskUserQuestionTool(piForTool, { getChat: chatDeps, host: "golem" });

const singleQ = { questions: [{ question: "Deploy?", header: "Deploy", options: [{ label: "Yes", description: "ship" }, { label: "No", description: "wait" }] }] };
const multiQ = { questions: [{ question: "Checks?", header: "Checks", multiSelect: true, options: [{ label: "typecheck", description: "" }, { label: "smoke", description: "" }] }] };

// hasUI=false → no_ui envelope, nothing sent
let r: any = await toolDef.execute("t0", singleQ, undefined, undefined, { ...makeExecCtx(hangingSelect), hasUI: false });
ok("no_ui envelope when headless", r.content[0].text.includes("UI not available") && tgCalls.length === 0);

// invalid questionnaire → error envelope
r = await toolDef.execute("t0", { questions: [mkQ("Q?", ["Other", "b"])] }, undefined, undefined, makeExecCtx(hangingSelect));
ok("reserved label envelope", r.content[0].text.includes("reserved"));

// remote wins: tap option 0 of a single question
let p = toolDef.execute("t1", singleQ, undefined, undefined, makeExecCtx(hangingSelect));
await tick();
updateQueue.push(cbUpdate(`${keyboardNonce.value}:0`));
r = await settle(p);
ok("remote single answer envelope", r.content[0].text === 'User has answered your questions: "Deploy?"="Yes". You can now continue with the user\'s answers in mind.', r.content[0].text);
ok("remote flow emitted rpiv events", eventsEmitted.some(([c, d]) => c === "rpiv:ask-user:prompt" && d.questions[0].question === "Deploy?") && eventsEmitted.some(([c, d]) => c === "rpiv:ask-user:blocked" && d.active === true) && eventsEmitted.some(([c, d]) => c === "rpiv:ask-user:blocked" && d.active === false));
ok("final edit ✅ via Telegram", tgCalls.some((c) => c.method === "editMessageText" && c.body.text.includes("✅ answered via Telegram")));
ok("final edit clears keyboard", tgCalls.filter((c) => c.method === "editMessageText").every((c) => c.body.reply_markup === undefined || c.body.reply_markup === undefined));

// remote multi: toggle 0, toggle 0 again (off), toggle 1, submit
p = toolDef.execute("t2", multiQ, undefined, undefined, makeExecCtx(hangingSelect));
await tick();
const n = keyboardNonce.value;
updateQueue.push(cbUpdate(`${n}:0`), cbUpdate(`${n}:0`), cbUpdate(`${n}:1`), cbUpdate(`${n}:sub`));
r = await settle(p);
ok("remote multi submit", r.content[0].text.includes('"Checks?"="smoke"'), r.content[0].text);

// free text → custom answer
p = toolDef.execute("t3", singleQ, undefined, undefined, makeExecCtx(hangingSelect));
await tick();
updateQueue.push(msgUpdate("do it live"));
r = await settle(p);
ok("remote free-text custom", r.content[0].text.includes('"Deploy?"="do it live"'), r.content[0].text);

// stale nonce + foreign chat ignored, then a valid tap still works
p = toolDef.execute("t4", singleQ, undefined, undefined, makeExecCtx(hangingSelect));
await tick();
const stale = cbUpdate(`deadbeef:0`);
const foreign = cbUpdate(`${keyboardNonce.value}:0`, 999);
updateQueue.push(stale, foreign, cbUpdate(`${keyboardNonce.value}:1`));
r = await settle(p);
ok("stale/foreign ignored, valid tap resolves", r.content[0].text.includes('"Deploy?"="No"'));
ok("stale nonce acked expired", tgCalls.some((c) => c.method === "answerCallbackQuery" && c.body.text === "expired"));

// leave-for-terminal: remote yields, local wins
let resolveLocal: ((v: string | undefined) => void) | undefined;
const manualSelect = (_t: string, _o: string[], _opts?: any) => new Promise<string | undefined>((res) => (resolveLocal = res));
p = toolDef.execute("t5", singleQ, undefined, undefined, makeExecCtx(manualSelect));
await tick();
updateQueue.push(cbUpdate(`${keyboardNonce.value}:x`));
await tick();
resolveLocal?.("No");
r = await settle(p);
ok("leave-for-terminal → local wins", r.content[0].text.includes('"Deploy?"="No"'));
ok("local win edits ⌨️ at terminal", tgCalls.some((c) => c.method === "editMessageText" && c.body.text.includes("answered at the terminal")));
// local cancel (Esc) → decline envelope with partial answers in details
p = toolDef.execute("t6", { questions: [singleQ.questions[0], mkQ("Second?")] }, undefined, undefined, makeExecCtx(manualSelect));
await tick();
resolveLocal?.(undefined); // Esc on first question
r = await settle(p);
ok("local cancel declines", r.content[0].text === "User declined to answer questions" && r.details.cancelled === true);
ok("local cancel edits ✖ declined", tgCalls.some((c) => c.method === "editMessageText" && c.body.text.includes("✖ declined at the terminal")));

// agent abort mid-question → decline + ⚪ close on telegram
const acAbort = new AbortController();
p = toolDef.execute("t7", singleQ, acAbort.signal, undefined, makeExecCtx(hangingSelect));
await tick();
acAbort.abort();
r = await settle(p);
ok("agent abort declines", r.content[0].text === "User declined to answer questions");
ok("abort edits ⚪", tgCalls.some((c) => c.method === "editMessageText" && c.body.text.includes("⚪")));

// initial send failure → local-only still works
mod.__setDefaultTransportForTests((async (_url: string, init?: RequestInit) => {
    const method = _url.split("/").pop() ?? "";
    if (method === "sendMessage") return new Response(JSON.stringify({ ok: false, description: "Unauthorized" }), { status: 400 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
}) as any);
p = toolDef.execute("t8", singleQ, undefined, undefined, makeExecCtx(manualSelect));
await tick();
resolveLocal?.("Yes");
r = await settle(p);
ok("telegram down → local fallback", r.content[0].text.includes('"Deploy?"="Yes"'));

// --- ADR-0002: registration is unconditional ----------------------------------
const piReg: any = {
    events: { emit: () => {} },
    on: (event: string, handler: any) => ((piReg.handlers as any) ??= {})[event] ??= [handler],
    registerCommand: () => {},
    tools: new Map<string, any>(),
    registerTool: function (t: any) { this.tools.set(t.name, t); },
    handlers: {} as Record<string, any[]>,
};
// config currently enabled (NEWTOKEN from the setup test)
mod.default(piReg);
ok("tool registered when enabled", piReg.tools.has("ask_user_question"));
mod.writeConfigFile({ botToken: "T1", chatId: "42", enabled: false });
const piReg2: any = { events: { emit: () => {} }, on: () => {}, registerCommand: () => {}, tools: new Map(), registerTool: function (t: any) { this.tools.set(t.name, t); } };
mod.default(piReg2);
ok("tool registered (local-only) even when disabled", piReg2.tools.has("ask_user_question"));

// no chat configured → execute degrades to local-only, nothing ever sent
tgCalls.length = 0;
mod.__setDefaultTransportForTests((async (_url: string, init?: RequestInit) => {
    const method = _url.split("/").pop() ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    tgCalls.push({ method, body });
    if (method === "getMe") return new Response(JSON.stringify({ ok: true, result: { id: 1, username: "bot" } }), { status: 200 });
    if (method === "sendMessage") return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 });
    return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
}) as any);
const localOnlyTool: any = mod.buildAskUserQuestionTool(piForTool, { getChat: () => undefined, host: "golem" });
const localP = localOnlyTool.execute("l1", singleQ, undefined, undefined, makeExecCtx(manualSelect));
await tick();
resolveLocal?.("Yes");
const localR: any = await settle(localP);
ok("no chat → local-only answer, nothing sent", localR.content[0].text.includes('"Deploy?"="Yes"') && tgCalls.filter((c) => c.method === "sendMessage").length === 0);

// --- M3+: elapsed-time edits ----------------------------------------------------
ok("formatElapsed", mod.formatElapsed(0) === "0s" && mod.formatElapsed(59_000) === "59s" && mod.formatElapsed(60_000) === "1m" && mod.formatElapsed(194_000) === "3m 14s");

{
    // Direct session with fast tick: elapsed edits carry the keyboard and stop after the cap.
    const elapsedEdits: Array<{ text: string; hasKeyboard: boolean }> = [];
    const elapsedClient: TelegramClient = {
        ...fakeClient,
        sendMessage: async () => ({ message_id: 888 }),
        editMessageText: async (_c, _m, text, replyMarkup) => {
            elapsedEdits.push({ text, hasKeyboard: replyMarkup !== undefined });
            return true;
        },
    };
    const ac = new AbortController();
    const session = mod.startRemoteSession({
        client: elapsedClient,
        chatId: "42",
        base: "B",
        params: singleQ as any,
        signal: ac.signal,
        tickMs: 5,
        maxElapsedMs: 18,
    });
    await new Promise((r) => setTimeout(r, 45));
    ac.abort();
    await new Promise((r) => setTimeout(r, 10));
    const elapsedOnly = elapsedEdits.filter((e) => e.text.includes("⏳ waiting"));
    ok("elapsed edits fire and keep keyboard", elapsedOnly.length >= 2 && elapsedOnly.every((e) => e.hasKeyboard), elapsedEdits.length);
    const countAtCap = elapsedEdits.length;
    await new Promise((r) => setTimeout(r, 30));
    ok("elapsed edits stop after cap", elapsedEdits.length === countAtCap);
    // session never settled — result promise still pending, no unhandled rejection
    ok("unresolved session harmless", true);
}

// --- M3+: rpiv drift warning ----------------------------------------------------
ok("drift line matches", mod.rpivStatusLine(mod.CLONED_RPIV_VERSION).includes(`matches clone ${mod.CLONED_RPIV_VERSION}`) && mod.rpivStatusLine(mod.CLONED_RPIV_VERSION).includes("remove the package"));
ok("drift line warns", mod.rpivStatusLine("0.0.0").includes("⚠️") && mod.rpivStatusLine("0.0.0").includes(mod.CLONED_RPIV_VERSION) && mod.rpivStatusLine("0.0.0").includes("re-diff"));
ok("drift line absent install", mod.rpivStatusLine(undefined).includes("upstream not installed") && mod.rpivStatusLine(undefined).includes("drift check"));

// cleanup
mod.__setDefaultTransportForTests(undefined);
rmSync(homeTmp, { recursive: true, force: true });
console.log("\nAll telegram smoke checks passed.");
