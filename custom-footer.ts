/**
 * Custom Footer Extension - colorful statusline with folder, git branch, token stats, context bar & model
 * Layout: [folder] [branch ±]              [↑sent] [↓recv] [context bar] [model]
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execSync } from "child_process";

function checkGitDirty(cwd: string): boolean {
    try {
        const output = execSync("git status --porcelain", { cwd, encoding: "utf-8", timeout: 3000 });
        return output.trim().length > 0;
    } catch {
        return false;
    }
}

function buildFooter(ctx: ExtensionCommandContext) {
    // null = stale, need to re-check; true = dirty; false = clean
    let dirty: boolean | null = null;

    return (tui: any, theme: any, footerData: any) => {
        // Re-check git dirty on file/branch changes and tool execution
        const onBranch = footerData.onBranchChange(() => {
            dirty = null;
            tui.requestRender();
        });

        const onToolResult = (_event: any) => {
            dirty = null;
            tui.requestRender();
        };
        const onUserBash = (_event: any) => {
            dirty = null;
            tui.requestRender();
        };
        ctx.on("tool_result", onToolResult);
        ctx.on("user_bash", onUserBash);

        const dispose = () => {
            onBranch();
            ctx.off("tool_result", onToolResult);
            ctx.off("user_bash", onUserBash);
        };

        return {
            dispose,
            invalidate() {},
            render(width: number): string[] {
                // Re-check dirty status if stale
                if (dirty === null) {
                    dirty = checkGitDirty(ctx.cwd || ".");
                }

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
                const gitSymbol = dirty ? "±" : "●";
                const gitColor = dirty ? "error" : "accent";
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
