// Smoke test for herdr-telegram-command.ts (M1) — fully offline: fake chat,
// fake clock, temp controller file, stubbed send/abort. No network, no pi.
//
// Run: node --experimental-strip-types scripts/smoke-command.mts

import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
});

ok("handler: subscribed to hub", (mod.bindHandler(handler, fakeHub), recordedSubs.length === 1));
const H = (u: any) => handler.handleUpdate(u);

// slash commands work regardless of controller state
H(msg("/steer tighten the types"));
ok("exec: /steer idle → plain send", sends.at(-1)?.text === "tighten the types" && sends.at(-1)?.mode === "send-now", sends.at(-1));
idle = false;
H(msg("/steer pivot to plan B"));
ok("exec: /steer streaming → steer", sends.at(-1)?.mode === "steer", sends.at(-1));
H(msg("/followup then typecheck"));
ok("exec: /followup streaming → followUp", sends.at(-1)?.mode === "followUp");
idle = true;
H(msg("/followup queued while idle"));
ok("exec: /followup idle → immediate send", sends.at(-1)?.mode === "send-now");
H(msg("/stop"));
ok("exec: /stop aborts", aborted === 1);
H(msg("/help"));
ok("exec: /help replies", !!(sent.at(-1)?.includes("/steer")));

// plain text: only as controller without an open question
H(msg("just checking in"));
ok("exec: plain text as controller", sends.at(-1)?.text === "just checking in" && sends.at(-1)?.mode === "send-now");
handler.onToolStart("ask_user_question");
H(msg("this should reach the wizard, not us"));
ok("exec: plain text declined while ask open", sends.at(-1)?.text === "just checking in");
handler.onToolEnd("ask_user_question");
H(msg("question closed, hearing again"));
ok("exec: plain text after ask closes", sends.at(-1)?.text === "question closed, hearing again");

// foreign targets parse + M2 notice
sent.length = 0;
H(msg("/steer wB:p2 from another pane"));
ok("exec: foreign target → M2 notice", !!(sent.at(-1)?.includes("M2")), sent.at(-1));

// /rc via Telegram flips the shared controller
sent.length = 0;
H(msg("/rc status"));
ok("exec: /rc status replies", !!(sent.at(-1)?.includes("rc:")));
H(msg("/rc off"));
ok("exec: /rc off disables", !ctl2.isController() && !existsSync(controllerPath));
H(msg("nobody hears this"));
ok("exec: plain ignored after /rc off", sends.at(-1)?.text === "question closed, hearing again");
H(msg("/steer still works after off"));
ok("exec: slash still works after /rc off", sends.at(-1)?.text === "still works after off");

// shutdown releases
ctl2.enable();
handler.onShutdown();
ok("shutdown: controller released", !existsSync(controllerPath));

// foreign chat is never claimed
sent.length = 0; sends.length = 0;
ok("exec: foreign chat unclaimed", !H(msg("/steer x", "13")));
ok("exec: nothing sent for foreign chat", sent.length === 0 && sends.length === 0);

rmSync(homeTmp, { recursive: true, force: true });
console.log("\nsmoke-command: all green");
