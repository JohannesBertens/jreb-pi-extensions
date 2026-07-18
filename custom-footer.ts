/**
 * Custom Footer Extension - colorful statusline with folder, git branch, token stats, context bar & model
 * Layout: [folder] [branch ±]              [↑sent] [↓recv] [context bar] [model]
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "node:child_process";

function getGitStatus(cwd: string): { branch: string | undefined; dirty: boolean } {
    // stdio must be explicit: execSync's default lets git's stderr leak to the
    // terminal (e.g. "fatal: not a git repository") even when we catch the error.
    const opts = { cwd, encoding: "utf-8" as const, timeout: 3000, stdio: ["ignore", "pipe", "pipe"] as const };
    try {
        const branch = execSync("git branch --show-current", opts).trim();
        const dirty = execSync("git status --porcelain", opts).trim().length > 0;
        return { branch: branch || undefined, dirty };
    } catch {
        return { branch: undefined, dirty: false };
    }
}

function buildFooter(ctx: ExtensionCommandContext) {
    return (tui: any, theme: any, footerData: any) => {
        const unsubBranch = footerData.onBranchChange(() => tui.requestRender());

        return {
            dispose() {
                unsubBranch();
            },
            render(width: number): string[] {
                // Token usage from session history
                let input = 0, output = 0;
                for (const e of ctx.sessionManager.getBranch()) {
                    if (e.type === "message" && e.message.role === "assistant") {
                        const m = e.message as AssistantMessage;
                        input += m.usage.input;
                        output += m.usage.output;
                    }
                }

                const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

                // Context window progress bar
                const totalTokens = input + output;
                const maxContext = ctx.model?.contextWindow || 0;
                let contextBar = "";
                if (maxContext > 0) {
                    const pct = Math.min(totalTokens / maxContext, 1);
                    const barLen = 15;
                    const filled = Math.round(pct * barLen);
                    const empty = barLen - filled;
                    const barColor = pct > 0.9 ? "error" : pct > 0.7 ? "warning" : "success";
                    contextBar = ` ${theme.fg("dim", "[")}${theme.fg(barColor, "█".repeat(filled))}${theme.fg("dim", "░".repeat(empty))}${theme.fg("dim", "]")} ${theme.fg("dim", fmt(totalTokens) + "/" + fmt(maxContext))}`;
                } else {
                    contextBar = ` ${theme.fg("dim", "ctx: " + fmt(totalTokens))}`;
                }

                // Colored segments
                const arrowIn = theme.fg("toolDiffAdded", "↑");
                const arrowOut = theme.fg("toolDiffRemoved", "↓");
                const inputStr = theme.fg("syntaxString", fmt(input));
                const outputStr = theme.fg("syntaxNumber", fmt(output));

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
                const right = `${arrowIn} ${inputStr} ${arrowOut} ${outputStr}${contextBar} ${modelStr}`;

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
