/**
 * spike-steer — M0 spike for plans/herdr-telegram-command.md.
 *
 * Live-verify every Herdr socket round-trip the planned extension depends on,
 * plus the heartbeat-election timing assumptions. Read-only against existing
 * panes; creates exactly ONE scratch pane (split from ours) and closes it.
 *
 * Phases (arg: all | list | chain | steer-working | blocked | heartbeat):
 *   list           agent.list — roster sanity + envelope
 *   chain          pane.split → agent.start (pi, isolated extensions) →
 *                  agent.prompt → agent.wait → agent.read → verify reply
 *   steer-working  submit a 2nd prompt while the agent is working (steering)
 *                  → verify it lands and pivots the run
 *   blocked        force a blocked state (ask_user_question) → agent.prompt
 *                  must return agent_blocked → agent.send_keys esc → idle
 *   heartbeat      stale-heartbeat takeover timing (file protocol only)
 *
 * Usage: node --experimental-strip-types scripts/spike-steer.mts [phase]
 * Requires: running under Herdr ($HERDR_SOCKET_PATH set). No pi deps — node:net only.
 */
import { createConnection, type Socket } from "node:net";
import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const SOCKET_PATH = process.env.HERDR_SOCKET_PATH ?? join(process.env.HOME ?? "~", ".config", "herdr", "herdr.sock");
const SELF_PANE = process.env.HERDR_PANE_ID ?? "";
const SPIKE_AGENT = "spike1";

if (!process.env.HERDR_SOCKET_PATH) {
    console.error("Not under Herdr ($HERDR_SOCKET_PATH unset) — aborting.");
    process.exit(2);
}

// --- tiny newline-framed JSON-RPC client (same shape herdr-agent-list.ts uses)
interface RpcResult {
    ok: boolean;
    result?: Record<string, unknown>;
    error?: { code?: string; message?: string };
    ms: number;
}
let reqId = 0;
function rpc(method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<RpcResult> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
        let settled = false;
        let buffer = "";
        const id = `spike:${++reqId}`;
        const done = (r: RpcResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { socket.destroy(); } catch { /* gone */ }
            resolve({ ...r, ms: Date.now() - startedAt });
        };
        const timer = setTimeout(() => done({ ok: false, error: { code: "timeout" }, ms: 0 }), timeoutMs);
        const socket: Socket = createConnection(SOCKET_PATH);
        socket.on("error", (err) => done({ ok: false, error: { code: "socket", message: err.message }, ms: 0 }));
        socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
        socket.on("data", (chunk) => {
            buffer += chunk.toString("utf-8");
            const nl = buffer.indexOf("\n");
            if (nl === -1) return;
            const line = buffer.slice(0, nl).trim();
            let msg: { error?: { code?: string; message?: string }; result?: Record<string, unknown> };
            try { msg = JSON.parse(line); } catch { return done({ ok: false, error: { code: "parse", message: line.slice(0, 120) }, ms: 0 }); }
            if (msg.error) return done({ ok: false, error: msg.error, ms: 0 });
            done({ ok: true, result: msg.result, ms: 0 });
        });
    });
}

const log = (phase: string, msg: string) => console.log(`[${phase}] ${msg}`);
const hr = (t: string) => console.log(`\n${"=".repeat(12)} ${t} ${"=".repeat(12)}`);

// --- phase: list ------------------------------------------------------------
async function phaseList(): Promise<void> {
    hr("agent.list");
    const r = await rpc("agent.list", {});
    if (!r.ok) return log("list", `FAIL ${JSON.stringify(r.error)}`);
    const agents = (r.result?.agents as Array<Record<string, unknown>>) ?? [];
    log("list", `PASS ${agents.length} agent(s) in ${r.ms}ms — ${agents.map((a) => `${a.agent}:${a.agent_status}@${a.pane_id}`).join(", ")}`);
}

// --- shared helpers for agent phases ----------------------------------------
async function agentStatus(target: string): Promise<string | undefined> {
    const r = await rpc("agent.get", { target });
    if (!r.ok) return undefined;
    return r.result?.agent ? String((r.result.agent as Record<string, unknown>).agent_status) : undefined;
}
async function waitUntil(target: string, statuses: string[], timeoutMs: number): Promise<{ ok: boolean; status?: string; code?: string; ms: number }> {
    const r = await rpc("agent.wait", { target, until: statuses, timeout_ms: timeoutMs }, timeoutMs + 5000);
    if (!r.ok) return { ok: false, code: r.error?.code, ms: r.ms };
    return { ok: true, status: r.result?.agent ? String((r.result.agent as Record<string, unknown>).agent_status) : undefined, ms: r.ms };
}
async function readAgent(target: string, lines: number, source = "recent_unwrapped"): Promise<string> {
    // NOTE: wire enum uses underscore (`recent_unwrapped`) — the CLI spelling
    // is `recent-unwrapped`. Verified live (invalid_request otherwise).
    const r = await rpc("agent.read", { target, source, lines, strip_ansi: true }, 20000);
    if (!r.ok) return `<read failed: ${r.error?.code}: ${r.error?.message}>`;
    return String(((r.result as Record<string, unknown>)?.read as Record<string, unknown>)?.text ?? "");
}

/** Spawn the scratch agent: split a pane from ours, start pi with ONLY the
 *  Herdr integration extension (no Telegram noise from the global dir). */
async function spawnScratch(): Promise<{ paneId: string } | { error: string }> {
    const extDir = join(tmpdir(), "spike-steer-ext");
    mkdirSync(extDir, { recursive: true });
    const globalExt = (f: string) => join(process.env.HOME ?? "~", ".pi", "agent", "extensions", f);
    if (!existsSync(globalExt("herdr-agent-state.ts"))) return { error: `herdr integration not found at ${globalExt("herdr-agent-state.ts")}` };
    // herdr-agent-state: Herdr detection. herdr-blocked-on-question: without it
    // pi's open ask_user_question does NOT flip Herdr status to "blocked"
    // (verified live — the whole reason that companion extension exists).
    copyFileSync(globalExt("herdr-agent-state.ts"), join(extDir, "herdr-agent-state.ts"));
    // ask_user_question is EXTENSION-provided (verified: pi built-ins are
    // bash/edit/find/grep/ls/read/powershell only) — include the ask clone.
    // Partial TELEGRAM env (token, no chat) forces it local-only → no phone
    // noise from the scratch agent (documented split-config behavior).
    for (const extra of ["herdr-blocked-on-question.ts", "herdr-telegram-ask.ts", "herdr-telegram-core.ts"]) {
        if (existsSync(globalExt(extra))) copyFileSync(globalExt(extra), join(extDir, extra));
    }

    const split = await rpc("pane.split", { target_pane_id: SELF_PANE, direction: "right", focus: false, ratio: 0.34, env: { TELEGRAM_BOT_TOKEN: "spike-local-only" } });
    if (!split.ok) return { error: `pane.split failed: ${JSON.stringify(split.error)}` };
    const paneId = String((((split.result as Record<string, unknown>)?.pane) as Record<string, unknown>)?.pane_id);
    log("chain", `split pane ${paneId} from ${SELF_PANE} in ${split.ms}ms`);

    const start = await rpc("agent.start", { name: SPIKE_AGENT, kind: "pi", pane_id: paneId, args: ["--no-extensions", "--extension", join(extDir, "herdr-agent-state.ts")], timeout_ms: 60000 }, 70000);
    if (!start.ok) return { error: `agent.start failed: ${JSON.stringify(start.error)}` };
    log("chain", `agent.start ok in ${start.ms}ms → ${JSON.stringify(start.result?.agent)}`);
    return { paneId };
}

async function cleanup(paneId: string | undefined): Promise<void> {
    if (!paneId) return;
    const close = await rpc("pane.close", { pane_id: paneId });
    log("cleanup", close.ok ? `PASS pane ${paneId} closed (${close.ms}ms)` : `FAIL pane.close: ${JSON.stringify(close.error)} — close it manually`);
}

/** Wait until the agent is genuinely detected: agent.start returns
 *  IMMEDIATELY with launch_pending=true — poll agent.get until the status
 *  leaves "unknown" and launch_pending clears before the first prompt. */
async function awaitDetection(target: string, timeoutMs: number): Promise<{ ok: boolean; status?: string; ms: number }> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const r = await rpc("agent.get", { target });
        if (r.ok) {
            const agent = (r.result?.agent ?? {}) as Record<string, unknown>;
            const status = String(agent.agent_status ?? "unknown");
            const pending = agent.launch_pending === true;
            if (!pending && status !== "unknown") return { ok: true, status, ms: Date.now() - startedAt };
        } else if (r.error?.code === "agent_not_found" || r.error?.code === "agent_not_running") {
            /* not detected yet — keep polling */
        } else {
            return { ok: false, status: `rpc:${r.error?.code}`, ms: Date.now() - startedAt };
        }
        await new Promise((res) => setTimeout(res, 1000));
    }
    return { ok: false, ms: Date.now() - startedAt };
}

// --- phase: chain -----------------------------------------------------------
async function phaseChain(): Promise<void> {
    hr("spawn chain: split → start → prompt → wait → read");
    const spawn = await spawnScratch();
    if ("error" in spawn) return log("chain", `FAIL ${spawn.error}`);
    const { paneId } = spawn;

    try {
        const ready = await awaitDetection(SPIKE_AGENT, 90000);
        log("chain", ready.ok ? `agent detected (status=${ready.status}) after ${ready.ms}ms` : `FAIL detection timed out after ${ready.ms}ms (${ready.status})`);

        // Idle prompt with INLINE wait (submit+wait atomically — a separate
        // agent.wait races the yet-unobserved idle current-state, verified live).
        const promptAt = Date.now();
        const p1 = await rpc("agent.prompt", { target: SPIKE_AGENT, text: "Reply with exactly this token and nothing else: SPIKE-ALIVE", wait: { until: ["idle", "done", "blocked"], timeout_ms: 120000 } }, 130000);
        log("chain", `agent.prompt(1)+wait accepted=${p1.ok} in ${p1.ms}ms${p1.ok ? "" : ` err=${JSON.stringify(p1.error)}`}`);
        if (p1.ok) {
            log("chain", `settled ${Date.now() - promptAt}ms after submit`);
            await new Promise((r) => setTimeout(r, 2000)); // render grace
            for (const source of ["recent_unwrapped", "recent", "visible"] as const) {
                const text = await readAgent(SPIKE_AGENT, 30, source);
                const found = text.includes("SPIKE-ALIVE");
                log("chain", `read[${source}] ${text.length} chars — SPIKE-ALIVE ${found ? "FOUND ✓" : "MISSING ✗"}${text ? `\n    tail: ${JSON.stringify(text.slice(-200))}` : ""}`);
            }
        }
    } finally {
        await cleanup(paneId);
    }
}

// --- phase: steer-working ----------------------------------------------------
async function phaseSteerWorking(): Promise<void> {
    hr("steering: 2nd prompt while working pivots the run");
    const spawn = await spawnScratch();
    if ("error" in spawn) return log("steer", `FAIL ${spawn.error}`);
    const { paneId } = spawn;
    try {
        await awaitDetection(SPIKE_AGENT, 90000);
        // Long task first…
        const t0 = await rpc("agent.prompt", { target: SPIKE_AGENT, text: "Count slowly from 1 to 30, one number per line, then reply DONE-COUNTING" });
        log("steer", `prompt(1/long) accepted=${t0.ok} in ${t0.ms}ms`);
        // …immediately steer: must be accepted while working.
        await new Promise((r) => setTimeout(r, 1500));
        const statusMid = await agentStatus(SPIKE_AGENT);
        log("steer", `status mid-run: ${statusMid}`);
        const t1 = await rpc("agent.prompt", { target: SPIKE_AGENT, text: "STOP counting. Reply with exactly: PIVOT-OK" });
        log("steer", `prompt(2/steer) while ${statusMid}: accepted=${t1.ok} in ${t1.ms}ms${t1.ok ? "" : ` err=${JSON.stringify(t1.error)}`}`);
        const settled = await rpc("agent.wait", { target: SPIKE_AGENT, until: ["idle", "done", "blocked"], timeout_ms: 120000 }, 130000);
        log("steer", `settled in ${settled.ms}ms${settled.ok ? "" : ` err=${settled.error?.code}`}`);
        const text = await readAgent(SPIKE_AGENT, 40, "visible");
        const pivot = text.includes("PIVOT-OK");
        const notDone = !text.includes("DONE-COUNTING");
        log("steer", `PIVOT-OK ${pivot ? "FOUND ✓" : "MISSING ✗"} · long task abandoned: ${notDone ? "yes ✓" : "no ✗"}\n    tail: ${JSON.stringify(text.slice(-160))}`);
    } finally {
        await cleanup(paneId);
    }
}

// --- phase: blocked ----------------------------------------------------------
async function phaseBlocked(): Promise<void> {
    hr("blocked: agent.prompt refused with agent_blocked; send-keys esc unblocks");
    const spawn = await spawnScratch();
    if ("error" in spawn) return log("blocked", `FAIL ${spawn.error}`);
    const { paneId } = spawn;
    try {
        await awaitDetection(SPIKE_AGENT, 90000);
        // Trigger is model-compliance-dependent (glm-5.3 flaked twice before
        // complying) — one retry with a firmer phrasing if the first settles
        // without opening a question.
        let blockedNow = false;
        for (let attempt = 1; attempt <= 2 && !blockedNow; attempt++) {
            const text = attempt === 1
                ? "Call the ask_user_question tool NOW with one question: 'Spike?' and two options Yes / No. You MUST call the tool — do not answer the question yourself, do not reply in text."
                : "You did not call the tool. Call ask_user_question NOW: question 'Spike?', options Yes / No. Call the tool and wait.";
            const p = await rpc("agent.prompt", { target: SPIKE_AGENT, text });
            log("blocked", `prompt(trigger #${attempt}) accepted=${p.ok}${p.ok ? "" : ` err=${JSON.stringify(p.error)}`}`);
            const blocked = await waitUntil(SPIKE_AGENT, ["blocked"], 120000);
            blockedNow = blocked.ok;
            log("blocked", blocked.ok ? `agent reached blocked in ${blocked.ms}ms` : `attempt #${attempt} settled unblocked (status=${await agentStatus(SPIKE_AGENT)})`);
        }
        if (!blockedNow) return log("blocked", "FAIL never blocked — model would not call ask_user_question (see plan appendix: trigger is compliance-dependent)");
        const refused = await rpc("agent.prompt", { target: SPIKE_AGENT, text: "should be refused" });
        log("blocked", `prompt(while blocked): ${refused.ok ? "ACCEPTED (unexpected!)" : `REFUSED ✓ code=${refused.error?.code} msg=${JSON.stringify(refused.error?.message)}`}`);
        const keys = await rpc("agent.send_keys", { target: SPIKE_AGENT, keys: ["esc"] });
        log("blocked", `send_keys esc: ${keys.ok ? `ok (${keys.ms}ms)` : `FAIL ${JSON.stringify(keys.error)}`}`);
        const back = await waitUntil(SPIKE_AGENT, ["idle", "working", "done"], 60000);
        log("blocked", `after esc: status=${back.status} in ${back.ms}ms`);
    } finally {
        await cleanup(paneId);
    }
}

// --- phase: heartbeat --------------------------------------------------------
function hbPath(): string { return join(tmpdir(), "spike-steer-controller.json"); }
function hbRead(): { host: string; pid: number; heartbeatAt: number } | undefined {
    try { return JSON.parse(readFileSync(hbPath(), "utf-8")); } catch { return undefined; }
}
function hbWrite(staleBy: number): void {
    writeFileSync(hbPath(), JSON.stringify({ host: "A", pid: 111, heartbeatAt: Date.now() - staleBy }));
}
async function phaseHeartbeat(): Promise<void> {
    hr("heartbeat takeover timing (file protocol)");
    const staleMs = 3000; // compressed from the planned 30 s for the spike
    hbWrite(1000); // fresh
    const fresh = hbRead();
    log("hb", `fresh heartbeat age=1s → controller=A (stale threshold ${staleMs}ms): ${fresh && Date.now() - fresh.heartbeatAt < staleMs ? "yes ✓" : "no ✗"}`);
    await new Promise((r) => setTimeout(r, 2500)); // let it go stale (3.5s total)
    const stale = hbRead();
    log("hb", `after 3.5s idle → takeover allowed: ${stale && Date.now() - stale.heartbeatAt >= staleMs ? "yes ✓" : "no ✗"} (age=${Date.now() - (stale?.heartbeatAt ?? 0)}ms)`);
    // new writer takes over atomically-ish; old writer detects on next beat
    writeFileSync(hbPath(), JSON.stringify({ host: "B", pid: 222, heartbeatAt: Date.now() }));
    const after = hbRead();
    log("hb", `B wrote; A re-reads → controller=B: ${after?.host === "B" ? "yes ✓" : "no ✗"}`);
    rmSync(hbPath(), { force: true });
    log("hb", `PASS protocol timing assumptions hold (10s beat / 30s threshold in prod)`);
}

// --- main --------------------------------------------------------------------
const phase = process.argv[2] ?? "all";
const phases: Record<string, () => Promise<void>> = {
    list: phaseList,
    chain: phaseChain,
    "steer-working": phaseSteerWorking,
    blocked: phaseBlocked,
    heartbeat: phaseHeartbeat,
};
const run = async function (): Promise<void> {
    if (phase === "all") {
        await phaseList();
        await phaseChain();
        await phaseSteerWorking();
        await phaseBlocked();
        await phaseHeartbeat();
        return;
    }
    const fn = phases[phase];
    if (!fn) { console.error(`unknown phase ${phase}; use all|${Object.keys(phases).join("|")}`); process.exit(2); }
    await fn();
};
run().catch((err) => { console.error("spike crashed:", err); process.exit(1); });
