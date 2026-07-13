/**
 * Custom Footer Extension - colorful statusline with token stats, context bar, model & git branch
 */
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function buildFooter(ctx: ExtensionCommandContext) {
    return (tui: any, theme: any, footerData: any) => {
        const unsub = footerData.onBranchChange(() => tui.requestRender());

        return {
            dispose: unsub,
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

                const branch = footerData.getGitBranch();
                const branchStr = branch ? " " + theme.fg("accent", `● ${branch}`) : "";

                const model = ctx.model?.id || "no-model";
                const modelStr = theme.fg("syntaxType", model);

                const left = `${arrowIn} ${inputStr} ${arrowOut} ${outputStr} ${sep}${branchStr}${contextBar}`;
                const right = modelStr;
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
