// M0 spike (plan §6 M0 a+b): prove that a globalThis-keyed singleton is shared
// across TWO independent jiti instances configured exactly like pi's extension
// loader (createJiti + moduleCache:false per load) — because pi re-creates jiti
// per extension file, plain module-level singletons would NOT be shared.
//
// Run: node --experimental-strip-types scripts/spike-jiti-singleton.mts
import { createJiti } from "jiti/static";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ok = (label: string, cond: boolean, detail?: unknown) => {
    if (!cond) {
        console.error(`FAIL: ${label}`, detail ?? "");
        process.exitCode = 1;
        throw new Error(label);
    }
    console.log(`✓ ${label}`);
};

const dir = mkdtempSync(join(tmpdir(), "spike-jiti-"));

// A stand-in for herdr-telegram-core.ts: globalThis-keyed singleton + no-op default.
const KEY = Symbol.for("spike.hub");
writeFileSync(
    join(dir, "core.ts"),
    `
const KEY = Symbol.for("spike.hub");
interface Hub { n: number }
function getHub(): Hub {
    const g = globalThis as Record<symbol, unknown>;
    return (g[KEY] as Hub) ??= { n: 0 };
}
export function bump(): number { return ++getHub().n; }
export function hubInstance(): Hub { return getHub(); }
export default function (_pi: unknown): void { /* no-op extension */ }
`,
);

// Stand-ins for the two consumer extensions: each imports the core relatively.
writeFileSync(join(dir, "consumer-a.ts"), `import { bump, hubInstance } from "./core.ts"; export default function () {}; export const api = { bump, hubInstance };`);
writeFileSync(join(dir, "consumer-b.ts"), `import { bump, hubInstance } from "./core.ts"; export default function () {}; export const api = { bump, hubInstance };`);

// pi's loader: a FRESH jiti per extension load, moduleCache disabled.
// (pi uses `{ default: true }` to get just the factory; we import the full
// namespace because the spike also needs the named exports.)
const load = async (p: string) => {
    const jiti = createJiti(import.meta.url, { moduleCache: false });
    return jiti.import(p) as Promise<Record<string, unknown>>;
};

const a: any = await load(join(dir, "consumer-a.ts"));
const b: any = await load(join(dir, "consumer-b.ts"));
const coreDirect: any = await load(join(dir, "core.ts"));

ok("consumer A default export is a function", typeof a.default === "function");
ok("core default export is a function (pi discovery needs it)", typeof coreDirect.default === "function");
coreDirect.default({ on: () => {}, registerCommand: () => {}, registerTool: () => {}, events: { emit: () => {} } });
ok("no-op default tolerates a stub pi", true);

const n1 = a.api.bump();
const n2 = b.api.bump();
ok("singleton shared across separate jiti instances (counter)", n1 === 1 && n2 === 2, { n1, n2 });
ok("identity shared across instances", a.api.hubInstance() === b.api.hubInstance());

// Negative control: a plain module-level counter would NOT be shared — confirm
// moduleCache:false really isolates module state (so the globalThis pattern is
// required, not paranoia).
writeFileSync(
    join(dir, "plain.ts"),
    `let n = 0; export function bump(): number { return ++n; }`,
);
writeFileSync(join(dir, "plain-a.ts"), `import { bump } from "./plain.ts"; export default function () {}; export const bump2 = bump;`);
writeFileSync(join(dir, "plain-b.ts"), `import { bump } from "./plain.ts"; export default function () {}; export const bump2 = bump;`);
const pa: any = await load(join(dir, "plain-a.ts"));
const pb: any = await load(join(dir, "plain-b.ts"));
const p1 = pa.bump2();
const p2 = pb.bump2();
ok("negative control: module-level state is NOT shared (why globalThis is required)", p1 === 1 && p2 === 1, { p1, p2 });

rmSync(dir, { recursive: true, force: true });
console.log("\nAll jiti-singleton spike checks passed.");
