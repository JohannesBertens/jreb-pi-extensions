// Spike (d): AbortController-driven long-poll loop (getUpdates pattern) inside a
// Node process — verifies clean abort mid-flight, error containment, and that the
// process exits promptly with nothing dangling. No network access needed.
//
// Usage: node --experimental-strip-types scripts/spike-longpoll.mts

import { createServer, type Server } from "node:http";

let requests = 0;
let inFlight = 0;

const server: Server = createServer((req, res) => {
    requests++;
    inFlight++;
    if (req.url?.startsWith("/instant")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: [{ update_id: 41 }] }));
        inFlight--;
        return;
    }
    // getUpdates-style hang; also honor client abort so the socket doesn't linger
    const timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, result: [] }));
    }, 25_000);
    res.on("close", () => {
        clearTimeout(timer);
        inFlight--;
    });
});

await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;

const unhandled: unknown[] = [];
process.on("unhandledRejection", (e) => unhandled.push(e));

function getUpdates(base: string, offset: number, signal: AbortSignal): Promise<{ result: { update_id: number }[] }> {
    // Long-poll: server hangs up to 25 s. AbortController cancels the socket.
    return fetch(`${base}/getUpdates?offset=${offset}&timeout=25`, { signal }).then((r) => r.json() as any);
}

let aborted = false;
let loopError: unknown;
const ac = new AbortController();

// Window-poll loop like the extension will run while a question is open.
const loop = (async () => {
    let offset = 0;
    console.log("  loop entered");
    while (!ac.signal.aborted) {
        console.log("  polling…");
        try {
            const data = await getUpdates(base, offset, ac.signal);
            if (data.result.length > 0) {
                offset = data.result[data.result.length - 1].update_id + 1;
                console.log(`  poll got update(s), next offset=${offset}`);
            } else {
                console.log("  poll empty");
            }
        } catch (err) {
            console.log("  poll catch:", (err as Error).name, (err as Error).message, "| signal.aborted =", ac.signal.aborted);
            if (ac.signal.aborted) {
                aborted = true;
                break; // clean exit: abort surfaced as AbortError
            }
            loopError = err; // e.g. 409 conflict → backoff path in real extension
            await new Promise((r) => setTimeout(r, 50));
        }
    }
    console.log("  loop exited, aborted flag =", aborted);
})();

// Simulate: one instant response arrives, then we abort mid-hang.
await new Promise((r) => setTimeout(r, 150));
console.log("aborting mid-long-poll… (signal.aborted =", ac.signal.aborted, ")");
ac.abort();
await loop;
console.log("after await loop: aborted =", aborted);

// A second, already-aborted controller must not even fetch.
const ac2 = new AbortController();
ac2.abort();
try {
    await getUpdates(`${base}/instant` as any, 0, ac2.signal);
    console.log("FAIL: pre-aborted fetch did not throw");
    process.exitCode = 1;
} catch {
    console.log("  pre-aborted fetch throws immediately ✓");
}

server.closeAllConnections?.();
await new Promise<void>((r) => server.close(() => r()));
await new Promise((r) => setTimeout(r, 100)); // let server 'close' events settle before counting

const pass =
    aborted &&
    loopError === undefined &&
    unhandled.length === 0 &&
    inFlight === 0 &&
    requests >= 1;

console.log(`\nrequests served: ${requests}, in-flight sockets: ${inFlight}, unhandled rejections: ${unhandled.length}`);
console.log(pass ? "PASS: window long-poll aborts cleanly, no dangling work — spike (d) OK" : "FAIL");
if (!pass) process.exitCode = 1;
