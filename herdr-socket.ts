/**
 * herdr-socket — shared plumbing for talking to the LOCAL Herdr server's
 * Unix-socket JSON-RPC API (newline-framed requests/responses).
 *
 * NOT an extension: the default export is a deliberate no-op so pi's
 * auto-discovery of ~/.pi/agent/extensions/*.ts loads this file without side
 * effects. Consumers: herdr-agent-list.ts (read), herdr-telegram-command.ts
 * (read + control: agent.prompt / agent.send_keys / agent.read / agent.wait).
 *
 * Wire facts (verified live 2026-08-30, herdr 0.8.2 / protocol 20 — see
 * jreb-memory research/remote-steering.md + plan Appendix A):
 *   - request:  {"id","method","params"}\n   — one line, then wait
 *   - response: {"id","result"|"error"}\n     — first JSON line wins
 *   - pane.close takes pane_id (PaneTarget), NOT target
 *   - agent.read wire enum: recent_unwrapped (underscore), visible, recent, detection
 *   - agent.start returns immediately with launch_pending — poll agent.get
 *
 * Zero runtime dependencies: node:net / node:os / node:fs only.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createConnection, type Socket } from "node:net";

// ---------------------------------------------------------------------------
// Socket factory (test seam)
// ---------------------------------------------------------------------------

export type SocketFactory = (socketPath: string) => Socket;

let socketFactory: SocketFactory = (socketPath) => createConnection(socketPath);

/** Test hook: swap the socket constructor (scripts/smoke-agents.mts etc.). */
export function __setHerdrSocketFactoryForTests(factory: SocketFactory | undefined): void {
    socketFactory = factory ?? ((socketPath) => createConnection(socketPath));
}

/** $HERDR_SOCKET_PATH when set; else the default socket if it exists; else undefined. */
export function herdrSocketPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    if (typeof env.HERDR_SOCKET_PATH === "string" && env.HERDR_SOCKET_PATH.length > 0) {
        return env.HERDR_SOCKET_PATH;
    }
    const fallback = join(env.HOME ?? "~", ".config", "herdr", "herdr.sock");
    return existsSync(fallback) ? fallback : undefined;
}

// ---------------------------------------------------------------------------
// Request/response
// ---------------------------------------------------------------------------

export type HerdrRequestResult =
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; code: string; message: string };

export interface HerdrRequestOptions {
    /** Per-request socket path (default: herdrSocketPath()). */
    socketPath?: string;
    /** Overall deadline, ms (default 8000). */
    timeoutMs?: number;
    /** Test seam override (default: the module factory). */
    factory?: SocketFactory;
}

let requestSeq = 0;

/**
 * One newline-framed JSON-RPC request over a fresh connection: connect, write
 * one line, parse the first response line, destroy. Never rejects — failures
 * are typed results so callers stay throw-free.
 */
export function herdrRequest(method: string, params: Record<string, unknown>, options: HerdrRequestOptions = {}): Promise<HerdrRequestResult> {
    const timeoutMs = options.timeoutMs ?? 8000;
    const socketPath = options.socketPath ?? herdrSocketPath();
    if (!socketPath) {
        return Promise.resolve({ ok: false, code: "no_socket", message: "not running under Herdr — no HERDR_SOCKET_PATH and no default socket found" });
    }
    const factory = options.factory ?? socketFactory;
    return new Promise((resolve) => {
        let settled = false;
        let buffer = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        const done = (result: HerdrRequestResult): void => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            try {
                socket.destroy();
            } catch {
                /* already gone */
            }
            resolve(result);
        };
        const socket: Socket = factory(socketPath);
        timer = setTimeout(() => done({ ok: false, code: "timeout", message: "Herdr socket timed out" }), timeoutMs);
        timer.unref?.();
        socket.on("error", (err: Error) => done({ ok: false, code: "unreachable", message: `Herdr socket unreachable (${err.message})` }));
        socket.on("connect", () => {
            socket.write(`${JSON.stringify({ id: `pi:${method}:${Date.now()}:${++requestSeq}`, method, params })}\n`);
        });
        socket.on("data", (chunk: Buffer) => {
            buffer += chunk.toString("utf8");
            const newline = buffer.indexOf("\n");
            if (newline === -1) return; // partial line — wait for more
            const line = buffer.slice(0, newline).trim();
            let message: { error?: { code?: string; message?: string }; result?: Record<string, unknown> };
            try {
                message = JSON.parse(line);
            } catch {
                done({ ok: false, code: "bad_response", message: `unexpected Herdr response: ${line.slice(0, 120)}` });
                return;
            }
            if (message.error) {
                done({ ok: false, code: message.error.code ?? "unknown", message: message.error.message ?? "no message" });
                return;
            }
            done({ ok: true, result: message.result ?? {} });
        });
        socket.on("end", () => {
            if (!settled && buffer.trim().length === 0) done({ ok: false, code: "closed", message: "Herdr socket closed before answering" });
        });
    });
}

// The default export is a no-op: shared plumbing, not an extension (same
// convention as herdr-telegram-core.ts — install.sh copies every root *.ts).
export default function herdrSocketNoop(): void {
    /* intentionally empty */
}
