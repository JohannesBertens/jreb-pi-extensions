// herdr-blocked-on-question.ts
//
// While pi presents an `ask_user_question` to the user, tell herdr the agent is
// "blocked" (needs attention) — so hardware readouts (e.g. the Stream Deck
// plugin) flip red instead of showing "busy".
//
// This is a companion to herdr-agent-state.ts (installed by
// `herdr integration install pi`), which already maps a `herdr:blocked` event
// onto the herdr `blocked` agent state. That file is herdr-managed and gets
// overwritten on update, so this hook lives in its OWN file beside it. Together:
// while a question is open the agent_status is `blocked`; the moment it is
// answered (or aborted) it returns to working/idle.
//
// Scope: only the `ask_user_question` tool — see ADR-0001 / CHANGELOG of
// opendeck-herdr for the background. Permission prompts are intentionally NOT
// covered here.
//
// Inert unless pi is running under herdr (HERDR_ENV=1); with no listener the
// emit is a harmless no-op.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const TOOL = "ask_user_question";

export default function (pi: ExtensionAPI) {
	if (process.env.HERDR_ENV !== "1") {
		return;
	}

	// toolCallIds of ask_user_question calls currently awaiting an answer, so we
	// never double-emit (nested / repeated questions) and always balance one
	// active -> one inactive.
	const open = new Set<string>();

	const block = () => pi.events.emit("herdr:blocked", { active: true, label: "awaiting answer" });
	const unblock = () => pi.events.emit("herdr:blocked", { active: false });

	// Ask opens: the tool has started and is about to render its question UI.
	pi.on("tool_execution_start", (event) => {
		if (event?.toolName !== TOOL) return;
		if (open.has(event.toolCallId)) return;
		open.add(event.toolCallId);
		block();
	});

	// Ask closes (answered, errored, or aborted): clear exactly this one entry.
	pi.on("tool_execution_end", (event) => {
		if (event?.toolName !== TOOL) return;
		if (!open.delete(event.toolCallId)) return; // was already cleared
		unblock();
	});

	// Safety net: if the run ends while a question is still open (e.g. the turn
	// was aborted mid-question and tool_execution_end didn't fire), drain the
	// remainder. herdr clamps its blocked counter at 0, so an extra inactive is
	// harmless — but an unmatched active would pin the pane red forever.
	pi.on("agent_end", () => {
		for (const _ of open) unblock();
		open.clear();
	});
}
