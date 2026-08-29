/**
 * Custom Footer Extension - colorful statusline with folder, git branch, token stats, context bar & model
 * Layout: [folder] [branch ±]              [↑sent] [↓recv] [R/W cache] [context bar] [model]
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { execSync, type ExecSyncOptionsWithStringEncoding } from "node:child_process";

type GitStatus = { branch: string | undefined; dirty: boolean };

// Short TTL cache: the footer re-renders often (token updates, branch changes,
// resizes) and getGitStatus would otherwise fork two git processes per render.
// 1 s keeps the dirty marker fresh enough for a human while bounding spawns.
const GIT_CACHE_TTL_MS = 1000;
const gitStatusCache = new Map<string, { at: number; value: GitStatus }>();

function runGitStatus(cwd: string): GitStatus {
    // stdio must be explicit: execSync's default lets git's stderr leak to the
    // terminal (e.g. "fatal: not a git repository") even when we catch the error.
    const opts: ExecSyncOptionsWithStringEncoding = {
        cwd,
        encoding: "utf-8",
        timeout: 3000,
        stdio: ["ignore", "pipe", "pipe"],
    };
    try {
        const branch = execSync("git branch --show-current", opts).trim();
        const dirty = execSync("git status --porcelain", opts).trim().length > 0;
        return { branch: branch || undefined, dirty };
    } catch {
        return { branch: undefined, dirty: false };
    }
}

function getGitStatus(cwd: string): GitStatus {
    const cached = gitStatusCache.get(cwd);
    if (cached && Date.now() - cached.at < GIT_CACHE_TTL_MS) return cached.value;
    const value = runGitStatus(cwd);
    gitStatusCache.set(cwd, { at: Date.now(), value });
    return value;
}

function buildFooter(ctx: ExtensionContext) {
    return (tui: TUI, theme: Theme, footerData: ReadonlyFooterDataProvider): Component & { dispose(): void } => {
        const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

        return {
            dispose() {
                unsubBranch();
            },
            invalidate() {
                // Nothing cached: render reads theme/usage/git state fresh each call.
            },
            render(width: number): string[] {
                // Cumulative token usage from session history (matches the stock
                // footer's totals: billed tokens across the whole session).
                // pi-ai normalizes `input` to exclude cached tokens; R/W shows
                // those separately when a cache is in use.
                let input = 0, output = 0, cacheRead = 0, cacheWrite = 0;
                for (const e of ctx.sessionManager.getBranch()) {
                    if (e.type === "message" && e.message.role === "assistant") {
                        const m = e.message as AssistantMessage;
                        input += m.usage.input;
                        output += m.usage.output;
                        cacheRead += m.usage.cacheRead;
                        cacheWrite += m.usage.cacheWrite;
                    }
                }

                const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

                // Context window progress bar from pi's own compaction-aware
                // estimate (agent-session.getContextUsage): the last valid
                // assistant usage total, unknown ("?") right after a compaction
                // until the next LLM response.
                const usage = ctx.getContextUsage();
                let contextBar = "";
                if (usage && usage.contextWindow > 0) {
                    const known = usage.tokens !== null;
                    const pct = known ? Math.min((usage.tokens as number) / usage.contextWindow, 1) : 0;
                    const barLen = 15;
                    const filled = Math.round(pct * barLen);
                    const empty = barLen - filled;
                    const barColor = pct > 0.9 ? "error" : pct > 0.7 ? "warning" : "success";
                    const label = known ? fmt(usage.tokens as number) : "?";
                    contextBar = ` ${theme.fg("dim", "[")}${theme.fg(barColor, "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}${theme.fg("dim", "]")} ${theme.fg("dim", label + "/" + fmt(usage.contextWindow))}`;
                }

                // Colored segments
                const arrowIn = theme.fg("toolDiffAdded", "↑");
                const arrowOut = theme.fg("toolDiffRemoved", "↓");
                const inputStr = theme.fg("syntaxString", fmt(input));
                const outputStr = theme.fg("syntaxNumber", fmt(output));
                // Cached-token totals, shown only when the model uses a cache —
                // pi-ai's `input` excludes them, so ↑ alone would understate the prompt.
                const cacheParts: string[] = [];
                if (cacheRead > 0) cacheParts.push(`R ${fmt(cacheRead)}`);
                if (cacheWrite > 0) cacheParts.push(`W ${fmt(cacheWrite)}`);
                const cacheStr = cacheParts.length ? ` ${theme.fg("dim", cacheParts.join(" "))}` : "";

                // Left: current folder + git branch
                const folderName = ctx.cwd.split("/").filter(Boolean).pop() || ctx.cwd;
                const folderStr = ` ${theme.fg("syntaxKeyword", folderName)}`;
                const git = getGitStatus(ctx.cwd);
                const gitSymbol = git.dirty ? "±" : "●";
                const gitColor = git.dirty ? "error" : "accent";
                const branchStr = git.branch ? ` ${theme.fg(gitColor, `[${gitSymbol} ${git.branch}]`)}` : "";
                const left = `${folderStr}${branchStr}`;

                // Right: token stats + context bar + model name
                const model = ctx.model?.id || "no-model";
                const modelStr = theme.fg("syntaxType", model);
                const right = `${arrowIn} ${inputStr} ${arrowOut} ${outputStr}${cacheStr}${contextBar} ${modelStr}`;

                const totalContentWidth = visibleWidth(left) + visibleWidth(right);
                const pad = " ".repeat(Math.max(1, width - totalContentWidth));

                return [truncateToWidth(left + pad + right, width)];
            },
        };
    };
}

export default function (pi: ExtensionAPI) {
    let enabled = true;

    // Enable footer on every session start
    pi.on("session_start", async (_event, ctx) => {
        if (enabled) {
            ctx.ui.setFooter(buildFooter(ctx));
        }
    });

    // Toggle command
    pi.registerCommand("footer", {
        description: "Toggle custom colorful footer",
        handler: async (_args, ctx) => {
            enabled = !enabled;

            if (enabled) {
                ctx.ui.setFooter(buildFooter(ctx));
                ctx.ui.notify("Custom footer enabled", "info");
            } else {
                ctx.ui.setFooter(undefined);
                ctx.ui.notify("Default footer restored", "info");
            }
        },
    });
}
