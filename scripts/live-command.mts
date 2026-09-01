/**
 * live-command — M2 live check for herdr-telegram-command cross-pane commands.
 *
 * Spawns a scratch pi agent (M0-style: split → start, isolated extensions,
 * local-only ask), then drives the REAL command handler (real Herdr socket,
 * fake Telegram chat) through /steer, /read, /agents, /wait and cleanup.
 * Manual — not part of `npm run smoke`. Run under Herdr:
 *   node --experimental-strip-types scripts/live-command.mts
 */
import { createConnection, type Socket } from "node:net";
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, hostname } from "node:os";

const mod = await import("../herdr-telegram-command.ts");
const socketMod = await import("../herdr-socket.ts");

const SOCKET = process.env.HERDR_SOCKET_PATH!;
const SELF = process.env.HERDR_PANE_ID!;
if (!SOCKET || !SELF) {
    console.error("Not under Herdr — aborting.");
    process.exit(2);
}

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exit(1);
    }
    console.log(`✓ ${label}`);
};

// --- raw socket helper (pane lifecycle only; commands go through the handler)
function rpc(method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<any> {
    return new Promise((resolve) => {
        let buf = "";
        const id = `live:${Date.now()}:${Math.random()}`;
        const s: Socket = createConnection(SOCKET);
        const t = setTimeout(() => { try { s.destroy(); } catch {} resolve({ ok: false, error: { code: "timeout" } }); }, timeoutMs);
        s.on("error", () => { clearTimeout(t); resolve({ ok: false, error: { code: "socket" } }); });
        s.on("connect", () => s.write(JSON.stringify({ id, method, params }) + "\n"));
        s.on("data", (c) => {
            buf += c.toString();
            const nl = buf.indexOf("\n");
            if (nl === -1) return;
            clearTimeout(t);
            try { const m = JSON.parse(buf.slice(0, nl)); resolve({ ok: !m.error, ...m }); } catch { resolve({ ok: false }); }
        });
    });
}

// --- fake Telegram chat capturing replies
const replies: string[] = [];
const fakeChat = {
    client: { sendMessage: async (_c: string, text: string) => { replies.push(text); return { message_id: replies.length }; } },
    chatId: "42",
};

// --- scratch agent (M0 recipe)
const extDir = join(tmpdir(), "spike-steer-ext");
mkdirSync(extDir, { recursive: true });
const g = (f: string) => join(process.env.HOME!, ".pi", "agent", "extensions", f);
for (const f of ["herdr-agent-state.ts", "herdr-blocked-on-question.ts", "herdr-telegram-ask.ts", "herdr-telegram-core.ts"]) {
    if (existsSync(g(f))) copyFileSync(g(f), join(extDir, f));
}
const NAME = "cmdtest";

// --- handler under test: REAL socket, fake chat, no controller needed
const handler = mod.createCommandHandler({
    getChat: () => fakeChat as any,
    isIdle: () => true,
    send: () => {}, // self-steer is covered by smoke; live test is cross-pane
    abort: () => {},
    rosterNames: async () => [NAME],
    now: Date.now,
});
const send = async (text: string) => {
    ok(`claimed "${text.split(" ")[0]}"`, handler.handleUpdate({ message: { chat: { id: 42 }, text } } as any));
    for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 25));
        if (replies.length > 0 && replies.at(-1) !== undefined) break; // reply landed
    }
    await new Promise((r) => setTimeout(r, 300));
    const reply = String(replies.at(-1) ?? "");
    replies.length = 0;
    return reply;
};

const split = await rpc("pane.split", { target_pane_id: SELF, direction: "right", focus: false, ratio: 0.34, env: { TELEGRAM_BOT_TOKEN: "live-local-only" } });
const paneId: string = split.result.pane.pane_id;
console.log(`scratch pane: ${paneId}`);
try {
    const start = await rpc("agent.start", { name: NAME, kind: "pi", pane_id: paneId, args: ["--no-extensions", "--extension", join(extDir, "herdr-agent-state.ts"), "--extension", join(extDir, "herdr-telegram-ask.ts")], timeout_ms: 60000 }, 70000);
    ok("scratch agent started", start.ok, start.error);
    for (let i = 0; i < 60; i++) {
        const g2 = await rpc("agent.get", { target: NAME });
        const a = g2.result?.agent;
        if (a && !a.launch_pending && a.agent_status && a.agent_status !== "unknown") break;
        await new Promise((r) => setTimeout(r, 1000));
    }
    console.log("scratch agent detected — driving commands…\n");

    // /steer by NAME (roster-aware targeting)
    let r = await send(`/steer ${NAME} Reply with exactly: LIVE-STEER-OK`);
    ok("/steer name accepted", r.includes("steered") && r.includes(NAME), r);
    await rpc("agent.wait", { target: NAME, until: ["idle", "done", "blocked"], timeout_ms: 120000 }, 130000);

    // /read shows the reply
    r = await send(`/read ${NAME} 30`);
    ok("/read shows reply", r.includes("LIVE-STEER-OK"), r.slice(0, 300));

    // /agents lists the scratch agent
    r = await send("/agents");
    ok("/agents roster includes scratch", r.includes(NAME) || r.includes(paneId), r.slice(0, 300));

    // /wait settles
    r = await send(`/wait ${NAME} 30000`);
    ok("/wait settles", r.includes("settled") && /idle|done/.test(r), r);

    // /keys esc is harmless when idle
    r = await send(`/keys ${NAME} esc`);
    ok("/keys esc sent", r.includes("esc"), r);

    console.log("\nlive-command: all green");
} finally {
    const close = await rpc("pane.close", { pane_id: paneId });
    console.log(`cleanup: pane ${paneId} ${close.ok ? "closed" : "CLOSE FAILED — do it manually"}`);
    rmSync(join(tmpdir(), "spike-steer-ext"), { recursive: true, force: true });
}
void socketMod;
void hostname;
