// Spike (a): does a file-extension same-name tool shadow the rpiv npm package's
// ask_user_question, both when registered at load time and at session_start?
// Runs a real headless SDK session against a temp agentDir that loads the real
// rpiv package + a probe extension, then inspects which definition serves the name.
//
// Usage: node --experimental-strip-types scripts/spike-shadow.mts
// Re-run after pi upgrades to re-verify the shadowing mechanism (see plan risk table).

import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL_AGENT_DIR = join(process.env.HOME!, ".pi/agent");
const RPIV_PACKAGE = join(REAL_AGENT_DIR, "npm/node_modules/@juicesharp/rpiv-ask-user-question");
const MARKER = "SPIKE-SHADOW-MARKER";

const PROBE_TS = `// @ts-nocheck
export default function (pi) {
  const def = {
    name: "ask_user_question",
    label: "ask user (spike shadow probe)",
    description: ${JSON.stringify(MARKER)},
    parameters: { type: "object", properties: {} },
    async execute() { return { output: "answered by spike shadow" }; },
  };
  const at = process.env.SPIKE_REGISTER_AT || "load";
  if (at === "load") {
    pi.registerTool(def);
  } else {
    let done = false;
    pi.on("session_start", async () => {
      console.error("[probe] session_start handler fired");
      if (done) return;
      done = true;
      try { pi.registerTool(def); } catch (err) { console.error("session_start registerTool failed:", err?.message ?? err); }
    });
  }
}
`;

async function probe(mode: "load" | "session_start"): Promise<boolean> {
    process.env.SPIKE_REGISTER_AT = mode;
    const agentDir = mkdtempSync(join(tmpdir(), "pi-spike-agent-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-spike-cwd-"));
    let shadowWins = false;
    try {
        mkdirSync(join(agentDir, "extensions"), { recursive: true });
        writeFileSync(join(agentDir, "extensions", "spike-shadow-probe.ts"), PROBE_TS);
        writeFileSync(
            join(agentDir, "settings.json"),
            JSON.stringify({ packages: [RPIV_PACKAGE] }, null, 2),
        );
        // Model runtime needs auth/models from the real agent dir.
        for (const f of ["auth.json", "models.json", "models-store.json"]) {
            try {
                symlinkSync(join(REAL_AGENT_DIR, f), join(agentDir, f));
            } catch {
                /* optional */
            }
        }
        const loader = new DefaultResourceLoader({ cwd, agentDir });
        await loader.reload();
        const { session } = await createAgentSession({
            resourceLoader: loader,
            sessionManager: SessionManager.inMemory(),
            cwd,
            agentDir,
        });
        // Internal registry probe: which definition currently serves the name?
        const defs = (session as any)._toolDefinitions as Map<string, { definition: any; sourceInfo: any }>;
        const entry = defs?.get("ask_user_question");
        if (!entry) throw new Error("ask_user_question not in registry at all");
        shadowWins = entry.definition.description === MARKER;
        const who = shadowWins ? "SHADOW (probe)" : "ORIGINAL (rpiv)";
        console.log(
            `[register@${mode}] serving: ${who}` +
                ` · source.path=${entry.sourceInfo?.path ?? "?"}` +
                ` · description=${entry.definition.description.slice(0, 40)}`,
        );
    } finally {
        delete process.env.SPIKE_REGISTER_AT;
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
    }
    return shadowWins;
}

const loadWins = await probe("load");
console.log("--- (above line for register@load may be filtered by temp paths; trust the summary) ---");
await new Promise((r) => setTimeout(r, 100)); // let any late async session_start handler settle
const sessionStartWins = await probe("session_start");
console.log(`\nregister-at-load wins:        ${loadWins ? "YES" : "no"}`);
console.log(`register@session_start wins: ${sessionStartWins ? "YES" : "no (session_start does not fire in SDK mode — fallback untestable headless; fires in TUI)"}`);
if (loadWins) {
    console.log("\nGO: load-time same-name registration shadows the npm package (packages resolve before local extensions — packageManager.resolve() inserts package extensions first). Re-verify after pi upgrades with this script.");
} else {
    console.log("\nNO-GO: load-time registration lost — investigate registry order before building Layer A.");
    process.exitCode = 1;
}
