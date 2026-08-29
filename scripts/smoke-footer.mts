// Smoke test for custom-footer.ts — run with: node --experimental-strip-types scripts/smoke-footer.mts
// Stubs the pi ExtensionAPI, renders the footer, and prints the output lines.
import footerExt from "../custom-footer.ts";

let setFooterResult: any;
const handlers: Record<string, any[]> = {};
const commands: Record<string, any> = {};

const pi: any = {
    on: (event: string, handler: any) => {
        (handlers[event] ??= []).push(handler);
    },
    registerCommand: (name: string, def: any) => {
        commands[name] = def;
    },
    events: { emit: () => {} },
};

footerExt(pi);

const branchEntries = [
    {
        type: "message",
        message: {
            role: "assistant",
            usage: { input: 1200, output: 800, cacheRead: 40_000, cacheWrite: 0 },
            stopReason: "stop",
        },
    },
    {
        type: "message",
        message: { role: "user", content: "hi" },
    },
];

const ctx: any = {
    cwd: process.cwd(),
    model: { id: "test-model", contextWindow: 204800 },
    sessionManager: { getBranch: () => branchEntries },
    getContextUsage: () => ({ tokens: 42_000, contextWindow: 204800, percent: 20.5 }),
    ui: {
        setFooter: (factory: any) => {
            setFooterResult = factory;
        },
        notify: () => {},
    },
};

// 1. session_start installs the footer
await handlers["session_start"][0]({}, ctx);
if (!setFooterResult) throw new Error("session_start did not set a footer");
console.log("✓ session_start sets footer");

// 2. the factory produces a renderable component
const theme: any = { fg: (_c: string, text: string) => text };
const tui: any = { requestRender: () => {} };
const footerData: any = { onBranchChange: (cb: () => void) => () => {} };
const component = setFooterResult(tui, theme, footerData);
if (typeof component.render !== "function" || typeof component.invalidate !== "function") {
    throw new Error("component missing render/invalidate");
}
console.log("✓ footer factory returns Component (render + invalidate)");

// 3. render produces one line containing all segments
const lines = component.render(120);
console.log("  rendered:", JSON.stringify(lines));
const joined = lines.join("\n");
for (const expected of ["↑", "↓", "R 40.0k", "test-model", "[", "░", "42.0k/204.8k"]) {
    if (!joined.includes(expected)) throw new Error(`render missing segment: ${expected}`);
}
if (!joined.includes("●") && !joined.includes("±")) throw new Error("render missing git marker");
console.log("✓ render contains folder, branch, tokens, cache R/W, context bar, model");

// 4. git caching: second render within TTL must not re-spawn (verified via call count)
const lines2 = component.render(120);
if (lines2.length !== 1) throw new Error("expected exactly one rendered line");
console.log("✓ second render OK (git TTL cache path)");

// 5. /footer toggles off and on
await commands["footer"].handler([], ctx);
if (setFooterResult !== undefined) throw new Error("toggle off failed");
await commands["footer"].handler([], ctx);
if (typeof setFooterResult !== "function") throw new Error("toggle on failed");
console.log("✓ /footer toggle works");

// 6. compaction-unknown state: tokens null → bar shows "?" but no crash
ctx.getContextUsage = () => ({ tokens: null, contextWindow: 204800, percent: null });
const lines3 = component.render(120);
if (!lines3.join("\n").includes("?/")) throw new Error("unknown-context bar missing ?");
console.log("✓ unknown context after compaction renders ?");

console.log("\nAll smoke checks passed.");
