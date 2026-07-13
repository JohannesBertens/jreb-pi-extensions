/**
 * Custom Footer Extension - colorful statusline with folder, git branch, token stats, context bar & model
 * Layout: [folder] [branch ±]              [↑sent] [↓recv] [context bar] [model]
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "child_process";

// Shared state accessible from pi-level event handlers
let currentTui: any = null;
let dirtyState: boolean | null = null;

function checkGitDirty(cwd: string): boolean {
    try {
        const output = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 3000 });
        return output.trim().length > 0;
    } catch {
        return false;
    }
}

function requestFooterRender() {
    if (dirtyState === null) {
        dirtyState = checkGitDirty(currentTui?.session?.cwd || ".");
    }
    currentTui?.requestRender();
}

function buildFooter(ctx: ExtensionCommandContext) {
    return (tui: any, theme: any, footerData: any) => {
        currentTui = tui;
        if (dirtyState === null) {
            dirtyState = checkGitDirty(ctx.cwd || ".");
        }

        const unsubBranch = footerData.onBranchChange(() => {
            dirtyState = null;
            tui.requestRender();
        });

        return {
            dispose() {
                unsubBranch();
            },
            invalidate() {},
            render(width: number): string[] {
                let input = 0, output = 0, totalTokens = 0;
                for (const e of ctx.sessionManager.getBranch()) {
                    if (e.type === "message" && e.message.role === "assistant") {
                        const m = e.message as AssistantMessage;
                        input += m.usage.input;
                        output += m.usage.output;
                        totalTokens += m.usage.input + m.usage.output;
                    }
                }

                const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);

                // Context size bar
                const maxContext = ctx.model?.contextWindow || 0;
                let contextBar = "";
                if (maxContext > 0) {
                    const pct = Math.min(totalTokens / maxContext, 1);
                    const barLen = 15;
                    const filled = Math.round(pct * barLen);
                    const empty = barLen - filled;
                    const barColor = pct > 0.9 ? "error" : pct > 0.7 ? "warning" : "success";
                    contextBar = " " + theme.fg("dim", "[") + theme.fg(barColor, "█".repeat(filled)) + theme.fg("dim", "░".repeat(empty)) + theme.fg("dim", "]") + " " + theme.fg("dim", fmt(totalTokens) + "/" + fmt(maxContext));
                } else {
                    contextBar = " " + theme.fg("dim", "ctx: " + fmt(totalTokens));
                }

                // Colored segments
                const arrowIn = theme.fg("toolDiffAdded", "↑");
                const arrowOut = theme.fg("toolDiffRemoved", "↓");
                const inputStr = theme.fg("syntaxString", fmt(input));
                const outputStr = theme.fg("syntaxNumber", fmt(output));
                const sep = theme.fg("borderMuted", "│");

                // Left: current folder + git branch
                const cwd = ctx.cwd || ".";
                const folderName = cwd.split("/").filter(Boolean).pop() || cwd;
                const folderStr = " " + theme.fg("syntaxKeyword", folderName) + "";
                const branch = footerData.getGitBranch();
                const gitSymbol = dirtyState ? "±" : "●";
                const gitColor = dirtyState ? "error" : "accent";
                const branchStr = branch ? " " + theme.fg(gitColor, `[${gitSymbol} ${branch}]`) : "";
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
    let enabled = true;  // enabled by default

    // Listen at pi level to invalidate dirty cache after file/branch changes and tool execution
    pi.on("tool_result", requestFooterRender);
    pi.on("user_bash", requestFooterRender);

    // Enable footer on every session start
    pi.on("session_start", async (_event, ctx) => {
        if (enabled) {
            ctx.ui.setFooter(buildFooter(ctx));
        }
    });

    // Keep /footer as toggle
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
