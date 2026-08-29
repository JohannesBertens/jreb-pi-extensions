/**
 * herdr-telegram-ask — Telegram companion for pi's `ask_user_question`.
 *
 * M1 (this file, notify layer): while pi has an `ask_user_question` open, send a
 * rich Telegram message (questions, options, session context) and edit it to ✅
 * (with the answer) when the question resolves. Two-way answering (same-name
 * tool shadow, buttons, races) is M2 — see jreb-memory plans/herdr-telegram-ask.md.
 *
 * Gating: inert unless pi runs under Herdr (`HERDR_ENV=1`), exactly like the
 * sibling `herdr-blocked-on-question.ts`. Within that, `/telegram setup` creates
 * the config; the notifier only fires when config exists and is enabled.
 *
 * Zero runtime dependencies: Node's global fetch only, and every network path is
 * funneled through an injectable Transport so scripts/smoke-telegram.mts can run
 * the whole thing without touching the network.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Static, Type } from "typebox";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface TelegramConfig {
    botToken: string;
    chatId: string;
    enabled: boolean;
}

const CONFIG_DIR = join(process.env.HOME ?? "~", ".pi", "agent");
const CONFIG_PATH = join(CONFIG_DIR, "herdr-telegram.json");
/** Telegram messages must stay under 4096 chars; leave headroom for the ✅ edit. */
const MAX_MESSAGE_CHARS = 3800;

export function readConfigFile(path: string = CONFIG_PATH): TelegramConfig | undefined {
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<TelegramConfig>;
        if (typeof raw.botToken !== "string" || raw.botToken.length === 0) return undefined;
        if (typeof raw.chatId !== "string" || raw.chatId.length === 0) return undefined;
        return { botToken: raw.botToken, chatId: raw.chatId, enabled: raw.enabled !== false };
    } catch {
        return undefined;
    }
}

export function writeConfigFile(config: TelegramConfig, path: string = CONFIG_PATH): void {
    writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    // writeFileSync mode only applies at creation; enforce on every save.
    chmodSync(path, 0o600);
}

/** Precedence: env overrides file; `source` tells status/setup where each field came from. */
export function loadConfig(
    env: Record<string, string | undefined> = process.env,
    path: string = CONFIG_PATH,
): { config: TelegramConfig | undefined; source: "env" | "file" | "none"; split: boolean } {
    const file = readConfigFile(path);
    const envToken = env.TELEGRAM_BOT_TOKEN?.trim();
    const envChat = env.TELEGRAM_CHAT_ID?.trim();
    if (envToken && envChat) {
        return { config: { botToken: envToken, chatId: envChat, enabled: file?.enabled ?? true }, source: "env", split: false };
    }
    if (envToken || envChat) {
        // Partial env config is never usable — say so rather than half-work.
        return { config: undefined, source: "none", split: true };
    }
    return { config: file, source: file ? "file" : "none", split: false };
}

// ---------------------------------------------------------------------------
// Telegram client (Bot API subset, injectable transport)
// ---------------------------------------------------------------------------

/** Minimal transport so tests can stub all network I/O. */
export type Transport = (url: string, init?: RequestInit) => Promise<Response>;

let defaultTransport: Transport = globalThis.fetch.bind(globalThis);

/** Test seam: swap the default transport so smoke tests never touch the network. */
export function __setDefaultTransportForTests(transport: Transport | undefined): void {
    defaultTransport = transport ?? globalThis.fetch.bind(globalThis);
}

export class TelegramApiError extends Error {
    public readonly method: string;
    public readonly description: string;
    constructor(method: string, description: string) {
        super(`Telegram ${method} failed: ${description}`);
        this.name = "TelegramApiError";
        this.method = method;
        this.description = description;
    }
}

interface TelegramResponse<T> {
    ok: boolean;
    result?: T;
    description?: string;
}

export interface TelegramClient {
    getMe(): Promise<{ id: number; username: string }>;
    sendMessage(chatId: string, text: string, replyMarkup?: unknown): Promise<{ message_id: number }>;
    editMessageText(chatId: string, messageId: number, text: string, replyMarkup?: unknown): Promise<boolean>;
    answerCallbackQuery(callbackQueryId: string, text?: string): Promise<boolean>;
    getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<TelegramUpdate[]>;
}

export interface TelegramUpdate {
    update_id: number;
    message?: { chat: { id: number; type: string }; text?: string; message_id?: number };
    callback_query?: {
        id: string;
        data?: string;
        message?: { chat: { id: number; type: string }; message_id: number };
    };
}

export function createTelegramClient(botToken: string, transport: Transport = defaultTransport): TelegramClient {
    const call = async <T>(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> => {
        const init: RequestInit = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(params),
            signal: signal ?? AbortSignal.timeout(15_000),
        };
        const res = await transport(`https://api.telegram.org/bot${botToken}/${method}`, init);
        const data = (await res.json()) as TelegramResponse<T>;
        if (!data.ok) throw new TelegramApiError(method, data.description ?? `HTTP ${res.status}`);
        return data.result as T;
    };
    return {
        getMe: () => call("getMe", {}),
        sendMessage: (chatId, text, replyMarkup) =>
            call("sendMessage", {
                chat_id: chatId,
                text,
                parse_mode: "HTML",
                link_preview_options: { is_disabled: true },
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }),
        editMessageText: (chatId, messageId, text, replyMarkup) =>
            call<{ boolean: boolean }>("editMessageText", {
                chat_id: chatId,
                message_id: messageId,
                text,
                parse_mode: "HTML",
                ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            }).then(() => true),
        answerCallbackQuery: (callbackQueryId, text) =>
            call<{ boolean: boolean }>("answerCallbackQuery", {
                callback_query_id: callbackQueryId,
                ...(text ? { text } : {}),
            }).then(() => true),
        getUpdates: (offset, timeoutSec, signal) =>
            call("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, signal),
    };
}

// ---------------------------------------------------------------------------
// Message rendering
// ---------------------------------------------------------------------------

export interface QuestionnaireArgs {
    questions?: Array<{
        question?: string;
        header?: string;
        multiSelect?: boolean;
        options?: Array<{ label?: string; description?: string; preview?: string }>;
    }>;
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function oneLine(text: string, max: number): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** The ✅-edit summary: first text block of the tool result (rpiv's answer envelope). */
export function resolveAnswerSummary(result: unknown): string | undefined {
    const content = (result as { content?: Array<{ type?: string; text?: unknown }> } | undefined)?.content;
    const text = Array.isArray(content) ? content[0]?.text : undefined;
    if (typeof text !== "string" || text.length === 0) return undefined;
    return oneLine(text, 180);
}

export interface RenderInput {
    args: QuestionnaireArgs;
    host: string;
    project: string;
    sessionName?: string;
    now?: Date;
    /** interactive = buttons present (shadow tool); notify = plain alert (fallback layer). */
    mode?: "interactive" | "notify";
}

export function renderQuestionnaireMessage(input: RenderInput): string {
    const now = input.now ?? new Date();
    const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    const questions = Array.isArray(input.args.questions) ? input.args.questions : [];

    const head =
        `🟡 <b>pi needs your input</b>\n` +
        `host:${escapeHtml(input.host)} · proj:${escapeHtml(input.project)}` +
        (input.sessionName ? ` · session:${escapeHtml(input.sessionName)}` : "") +
        ` · since ${time}`;

    const body: string[] = [];
    let truncated = false;
    let hasPreview = false;

    questions.forEach((q, i) => {
        const label = oneLine(typeof q.question === "string" ? q.question : `Question ${i + 1}`, 160);
        const mode = q.multiSelect ? "pick any" : "pick one";
        body.push(`\n<b>[${i + 1}/${questions.length}] ${escapeHtml(label)}</b> <i>(${mode})</i>`);
        const options = Array.isArray(q.options) ? q.options : [];
        options.forEach((o, j) => {
            if (typeof o.preview === "string" && o.preview.length > 0) hasPreview = true;
            const optLabel = escapeHtml(oneLine(typeof o.label === "string" ? o.label : `option ${j + 1}`, 80));
            const desc = typeof o.description === "string" && o.description.trim() ? ` — ${escapeHtml(oneLine(o.description, 160))}` : "";
            body.push(`${j + 1}. <b>${optLabel}</b>${desc}`);
        });
        if (options.length === 0) body.push("<i>(no options — custom answer)</i>");
    });

    if (questions.length === 0) body.push("\n<i>(questionnaire could not be parsed — see terminal)</i>");

    // Budget: truncate question bodies from the middle if over the Telegram limit.
    const tail =
        `\n${hasPreview ? "<i>(option previews not shown here)</i>\n" : ""}` +
        (input.mode === "interactive"
            ? "Tap an option or reply with text — or answer at the terminal."
            : "Answer at the terminal (remote answering unavailable).");
    while (head.length + body.join("\n").length + tail.length > MAX_MESSAGE_CHARS && body.length > 1) {
        const mid = Math.floor(body.length / 2);
        body.splice(mid, 1);
        truncated = true;
    }
    if (truncated) body.push("\n<b>… (truncated — full questionnaire at the terminal)</b>");

    return head + body.join("\n") + tail;
}

// ---------------------------------------------------------------------------
// Notifier (Layer N)
// ---------------------------------------------------------------------------

export interface NotifierDeps {
    client: TelegramClient;
    chatId: string;
    /** ctx.ui.notify stand-in; used for contained error surfacing. */
    notify: (message: string, level: "info" | "error") => void;
    host?: string;
}

interface OpenQuestion {
    messageId: number;
    startedAt: number;
    text: string;
}

const ERROR_NOTIFY_INTERVAL_MS = 5 * 60 * 1000;

export function createNotifier(deps: NotifierDeps) {
    const open = new Map<string, OpenQuestion>();
    /** toolCallIds whose send is still in flight; if they end first, edit on landing. */
    const pendingEnds = new Map<string, { summary?: string; isError: boolean; startedAt: number }>();
    let lastErrorNotify = 0;

    /** Surface at most one Telegram failure notice per interval; never throw to pi. */
    const fail = (err: unknown) => {
        if (Date.now() - lastErrorNotify < ERROR_NOTIFY_INTERVAL_MS) return;
        lastErrorNotify = Date.now();
        const message = err instanceof Error ? err.message : String(err);
        deps.notify(`telegram notify failed: ${message}`, "error");
    };

    const waited = (startedAt: number): string => {
        const secs = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
        return secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}m ${secs % 60}s`;
    };

    const editResolved = (messageId: number, text: string, startedAt: number, summary: string | undefined, isError: boolean): void => {
        const resolved = isError ? `⚠️ closed with error (waited ${waited(startedAt)})` : `✅ resolved (waited ${waited(startedAt)})`;
        const edit = summary ? `${text}\n\n<b>${resolved}</b>\n${escapeHtml(summary)}` : `${text}\n\n<b>${resolved}</b>`;
        deps.client.editMessageText(deps.chatId, messageId, edit).catch(() => {
            /* message may be deleted/unchanged; nothing to recover */
        });
    };

    return {
        onToolStart(event: { toolCallId: string; toolName: string; args?: unknown }, ctx: ExtensionContext): void {
            if (event.toolName !== "ask_user_question" || open.has(event.toolCallId)) return;
            const startedAt = Date.now();
            const text = renderQuestionnaireMessage({
                args: (event.args ?? {}) as QuestionnaireArgs,
                host: deps.host ?? hostname(),
                project: basename(ctx.cwd),
                sessionName: ctx.sessionManager.getSessionName() ?? undefined,
            });
            deps.client
                .sendMessage(deps.chatId, text)
                .then(({ message_id }) => {
                    const earlyEnd = pendingEnds.get(event.toolCallId);
                    if (earlyEnd) {
                        // Question already ended before the send landed — resolve immediately.
                        pendingEnds.delete(event.toolCallId);
                        editResolved(message_id, text, earlyEnd.startedAt, earlyEnd.summary, earlyEnd.isError);
                        return;
                    }
                    open.set(event.toolCallId, { messageId: message_id, startedAt, text });
                })
                .catch(fail);
        },

        onToolEnd(event: { toolCallId: string; toolName: string; result?: unknown; isError?: boolean }): void {
            if (event.toolName !== "ask_user_question") return;
            const summary = resolveAnswerSummary(event.result);
            const isError = event.isError === true;
            const q = open.get(event.toolCallId);
            if (!q) {
                // Send still in flight — remember and let the landing send resolve it.
                if (pendingEnds.size < 16) {
                    pendingEnds.set(event.toolCallId, { summary, isError, startedAt: Date.now() });
                }
                return;
            }
            open.delete(event.toolCallId);
            editResolved(q.messageId, q.text, q.startedAt, summary, isError);
        },

        /** Safety net: agent turn ended while a question was still open (abort, crash). */
        drain(): void {
            for (const [id, q] of open) {
                open.delete(id);
                pendingEnds.delete(id);
                deps.client
                    .editMessageText(deps.chatId, q.messageId, `${q.text}\n\n⚪ closed without an answer (turn ended) — waited ${waited(q.startedAt)}`)
                    .catch(() => {});
            }
        },

        get openCount(): number {
            return open.size;
        },
    };
}

export type Notifier = ReturnType<typeof createNotifier>;

// ---------------------------------------------------------------------------
// Layer A — rpiv contract clone (provenance: plan §8(b), rpiv 2.7.1)
// ask_user_question is NOT a pi builtin; it is registered by the npm package
// @juicesharp/rpiv-ask-user-question. We shadow the same tool name (M0a: our
// load-time registration wins) with a byte-compatible contract so the model
// sees an identical tool. The package itself is not importable from a file
// extension — hence this frozen clone. Re-clone when upgrading rpiv.
// ---------------------------------------------------------------------------

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;
/** Auto-appended sentinel rows + CC-parity label — never authorable (rpiv RESERVED_LABELS). */
export const RESERVED_LABELS = ["Other", "Type something.", "Next"] as const;

const OptionSchema = Type.Object({
    label: Type.String({
        maxLength: MAX_LABEL_LENGTH,
        description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
    }),
    description: Type.String({
        description:
            "Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
    }),
    preview: Type.Optional(
        Type.String({
            description:
                "Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
        }),
    ),
});

const QuestionSchema = Type.Object({
    question: Type.String({
        description:
            'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
    }),
    header: Type.String({
        maxLength: MAX_HEADER_LENGTH,
        description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
    }),
    options: Type.Array(OptionSchema, {
        minItems: MIN_OPTIONS,
        maxItems: MAX_OPTIONS,
        description:
            "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
    }),
    multiSelect: Type.Optional(
        Type.Boolean({
            default: false,
            description:
                "Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
        }),
    ),
});

export const QuestionParamsSchema = Type.Object({
    questions: Type.Array(QuestionSchema, {
        minItems: 1,
        maxItems: MAX_QUESTIONS,
        description: "Questions to ask the user (1-4 questions)",
    }),
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

export interface QuestionAnswer {
    questionIndex: number;
    question: string;
    kind: "option" | "custom" | "multi";
    answer: string | null;
    selected?: string[];
    notes?: string;
    preview?: string;
}

export type QuestionnaireError =
    | "no_ui"
    | "no_questions"
    | "empty_options"
    | "too_many_questions"
    | "duplicate_question"
    | "duplicate_option_label"
    | "reserved_label";

export interface QuestionnaireResult {
    answers: QuestionAnswer[];
    cancelled: boolean;
    error?: QuestionnaireError;
}

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set(RESERVED_LABELS);

export type ValidationResult = { ok: true } | { ok: false; error: QuestionnaireError; message: string };

/** Clone of rpiv's runtime validator (incl. reserved-before-duplicate ordering). */
export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
    if (typed.questions.length === 0) {
        return { ok: false, error: "no_questions", message: "Error: At least one question is required" };
    }
    if (typed.questions.length > MAX_QUESTIONS) {
        return { ok: false, error: "too_many_questions", message: `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation` };
    }
    const seenQuestions = new Set<string>();
    for (const q of typed.questions) {
        if (seenQuestions.has(q.question)) {
            return { ok: false, error: "duplicate_question", message: "Error: Question text must be unique within an invocation" };
        }
        seenQuestions.add(q.question);
    }
    for (const q of typed.questions) {
        if (q.options.length < MIN_OPTIONS) {
            return { ok: false, error: "empty_options", message: `Error: Each question requires at least ${MIN_OPTIONS} options` };
        }
        const seenLabels = new Set<string>();
        for (const o of q.options) {
            if (RESERVED_LABEL_SET.has(o.label)) {
                return { ok: false, error: "reserved_label", message: `Error: Option label is reserved (${RESERVED_LABELS.join(", ")})` };
            }
            if (seenLabels.has(o.label)) {
                return { ok: false, error: "duplicate_option_label", message: "Error: Option labels must be unique within a question" };
            }
            seenLabels.add(o.label);
        }
    }
    return { ok: true };
}

// --- envelope (clone of rpiv response-envelope.ts / format-answer.ts) ---------

const DECLINE_MESSAGE = "User declined to answer questions";
const ENVELOPE_PREFIX = "User has answered your questions:";
const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";
const NO_INPUT_PLACEHOLDER = "(no input)";

function formatAnswerScalar(a: QuestionAnswer): string {
    switch (a.kind) {
        case "multi":
            return a.selected && a.selected.length > 0 ? a.selected.join(", ") : NO_INPUT_PLACEHOLDER;
        case "custom":
            return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
        case "option":
            return a.answer ?? NO_INPUT_PLACEHOLDER;
    }
}

function buildAnswerSegment(a: QuestionAnswer): string {
    const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
    if (a.preview && a.preview.length > 0) parts.push(`selected preview: ${a.preview}`);
    if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
    return `${parts.join(". ")}.`;
}

export function buildQuestionnaireResponse(result: QuestionnaireResult | null | undefined, params: QuestionParams) {
    if (!result || result.cancelled) {
        return buildToolResult(DECLINE_MESSAGE, { answers: result?.answers ?? [], cancelled: true });
    }
    const segments: string[] = [];
    for (let i = 0; i < params.questions.length; i++) {
        const a = result.answers.find((x) => x.questionIndex === i);
        if (a) segments.push(buildAnswerSegment(a));
    }
    if (segments.length === 0) {
        return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
    }
    return buildToolResult(`${ENVELOPE_PREFIX} ${segments.join(" ")} ${ENVELOPE_SUFFIX}`, result);
}

export function buildToolResult(text: string, details: QuestionnaireResult) {
    return {
        content: [{ type: "text" as const, text }],
        details,
    };
}

// --- tool meta (verbatim from rpiv ask-user-question.ts) ----------------------

export const TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

export const PROMPT_SNIPPET = `Ask the user up to ${MAX_QUESTIONS} structured questions (${MIN_OPTIONS}-${MAX_OPTIONS} options each) when requirements are ambiguous`;

export const PROMPT_GUIDELINES: string[] = [
    `Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to ${MAX_QUESTIONS} questions per invocation.`,
    `Each question MUST have ${MIN_OPTIONS}-${MAX_OPTIONS} options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.`,
    `Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and append "(Recommended)" to its label.`,
    "Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.",
];

// ---------------------------------------------------------------------------
// Layer A — remote (Telegram) interactive session
// ---------------------------------------------------------------------------

const NO_KEYBOARD = undefined;

type Keyboard = Array<Array<{ text: string; callback_data: string }>>;

interface RemoteSessionState {
    nonce: string;
    messageId: number;
    base: string;
    params: QuestionParams;
    current: number;
    toggled: Set<number>;
    answers: QuestionAnswer[];
}

function currentQuestionline(state: RemoteSessionState): string {
    const q = state.params.questions[state.current];
    return `[${state.current + 1}/${state.params.questions.length}] ${q.question}`;
}

/** Progress block appended to the base message while the wizard is running. */
export function remoteProgressText(state: RemoteSessionState): string {
    const lines: string[] = [];
    for (const a of state.answers) {
        lines.push(`✅ ${escapeHtml(oneLine(a.question, 60))} → ${escapeHtml(oneLine(formatAnswerScalar(a), 80))}`);
    }
    lines.push(`▶️ <b>Now answering:</b> ${escapeHtml(oneLine(currentQuestionline(state), 120))}`);
    if (state.params.questions[state.current].multiSelect) {
        const picked = [...state.toggled].map((i) => state.params.questions[state.current].options[i].label);
        lines.push(`<i>pick any — selected: ${picked.length ? escapeHtml(picked.join(", ")) : "none"} · reply with text for a custom answer</i>`);
    } else {
        lines.push(`<i>tap an option, or reply with text for a custom answer</i>`);
    }
    return `\n\n${lines.join("\n")}`;
}

/** Inline keyboard for the current question. */
export function buildKeyboard(state: RemoteSessionState): Keyboard {
    const q = state.params.questions[state.current];
    const rows: Keyboard = [];
    q.options.forEach((o, i) => {
        const mark = q.multiSelect && state.toggled.has(i) ? "✓ " : "";
        rows.push([{ text: `${mark}${i + 1} · ${oneLine(o.label, 56)}`, callback_data: `${state.nonce}:${i}` }]);
    });
    if (q.multiSelect) {
        rows.push([{ text: "✅ Submit", callback_data: `${state.nonce}:sub` }]);
    }
    rows.push([{ text: "✕ Leave for terminal", callback_data: `${state.nonce}:x` }]);
    return rows;
}

export interface RemoteSessionDeps {
    client: TelegramClient;
    chatId: string;
    base: string;
    params: QuestionParams;
    signal: AbortSignal;
}

export interface RemoteSession {
    /** Resolves ONLY on a complete remote answer. Dismissal/failure: never settles. */
    readonly result: Promise<QuestionnaireResult>;
    /** Edit the Telegram message after the race was decided elsewhere. */
    settledRemotely(summaryLines: string[]): void;
    closedExternally(reason: string): void;
}

/**
 * Runs the sequential questionnaire wizard inside ONE Telegram message while
 * window-polling getUpdates (only while the question is open — no permanent
 * poller, 409-safe with backoff; M0d). Only the allowlisted chat is served;
 * stale nonces (question already closed) are acked "expired" and ignored.
 */
export function startRemoteSession(deps: RemoteSessionDeps): RemoteSession {
    const { client, chatId, params, signal } = deps;
    const state: RemoteSessionState = {
        nonce: randomUUID().slice(0, 8),
        messageId: 0,
        base: deps.base,
        params,
        current: 0,
        toggled: new Set(),
        answers: [],
    };
    let resolveResult: ((r: QuestionnaireResult) => void) | undefined;
    const result = new Promise<QuestionnaireResult>((resolve) => {
        resolveResult = resolve;
    });
    let settled = false;
    let dismissed = false;
    let offset = 0;

    const edit = (text: string, keyboard?: Keyboard) =>
        client.editMessageText(chatId, state.messageId, text, keyboard ? { inline_keyboard: keyboard } : NO_KEYBOARD).catch(() => {});

    const finishRemote = (): void => {
        settled = true;
        const summary = state.answers.map((a) => `✅ ${escapeHtml(oneLine(a.question, 60))} → ${escapeHtml(oneLine(formatAnswerScalar(a), 80))}`);
        edit(`${state.base}\n\n${summary.join("\n")}\n\n<b>✅ answered via Telegram</b>`);
        resolveResult?.({ answers: state.answers, cancelled: false });
    };

    const advance = (answer: QuestionAnswer): void => {
        state.answers.push(answer);
        state.current += 1;
        state.toggled.clear();
        if (state.current >= params.questions.length) {
            finishRemote();
        } else {
            edit(state.base + remoteProgressText(state), buildKeyboard(state));
        }
    };

    const answerOption = (i: number): void => {
        const q = params.questions[state.current];
        if (q.multiSelect) {
            if (state.toggled.has(i)) state.toggled.delete(i);
            else state.toggled.add(i);
            edit(state.base + remoteProgressText(state), buildKeyboard(state));
        } else {
            advance({
                questionIndex: state.current,
                question: q.question,
                kind: "option",
                answer: q.options[i].label,
                ...(typeof q.options[i].preview === "string" && q.options[i].preview ? { preview: q.options[i].preview } : {}),
            });
        }
    };

    const handleCallback = (cb: NonNullable<TelegramUpdate["callback_query"]>): void => {
        const cbChat = String(cb.message?.chat?.id ?? "");
        if (cbChat !== chatId) return;
        const ack = (text?: string) => client.answerCallbackQuery(cb.id, text).catch(() => {});
        const data = cb.data ?? "";
        const [nonce, rest] = data.split(":");
        if (nonce !== state.nonce) {
            ack("expired");
            return;
        }
        if (settled) return;
        if (rest === "x") {
            dismissed = true;
            ack("left for the terminal");
            edit(`${state.base}\n\n⌨️ left for the terminal`);
            return;
        }
        if (rest === "sub") {
            const q = params.questions[state.current];
            ack("submitted");
            advance({
                questionIndex: state.current,
                question: q.question,
                kind: "multi",
                answer: null,
                selected: [...state.toggled].sort((a, b) => a - b).map((i) => q.options[i].label),
            });
            return;
        }
        const optIdx = Number(rest);
        if (!Number.isInteger(optIdx) || optIdx < 0 || optIdx >= params.questions[state.current].options.length) {
            ack();
            return;
        }
        ack(`✓ ${oneLine(params.questions[state.current].options[optIdx].label, 40)}`);
        answerOption(optIdx);
    };

    const handleMessage = (msg: NonNullable<TelegramUpdate["message"]>): void => {
        if (String(msg.chat?.id) !== chatId || msg.chat?.type !== "private") return;
        const text = (msg.text ?? "").trim();
        if (!text || text.startsWith("/")) return;
        if (settled || dismissed) return;
        // Free text = custom answer for the current question (replaces multi toggles).
        const q = params.questions[state.current];
        advance({ questionIndex: state.current, question: q.question, kind: "custom", answer: text });
    };

    const poll = async (): Promise<void> => {
        let backoff = 500;
        while (!settled && !dismissed && !signal.aborted) {
            try {
                const updates = await client.getUpdates(offset, 25, signal);
                backoff = 500;
                for (const u of updates) {
                    offset = u.update_id + 1;
                    if (u.callback_query) handleCallback(u.callback_query);
                    else if (u.message) handleMessage(u.message);
                    if (settled) return;
                }
                if (updates.length === 0) {
                    // Long-polling servers hold the request for ~25 s, so an empty
                    // return normally costs nothing. But a server that returns
                    // instantly (misconfigured proxy, or a stub) must not spin this
                    // loop — pace empty polls defensively.
                    await new Promise((r) => setTimeout(r, 250));
                }
            } catch {
                if (signal.aborted || settled) return;
                // 409 (another pi process polling) or transient failure: back off.
                await new Promise((r) => setTimeout(r, backoff + Math.random() * backoff));
                backoff = Math.min(backoff * 2, 5000);
            }
        }
    };

    // Fire the initial message; failures leave `result` pending forever (race then
    // runs local-only) and surface through the caller's notify path.
    client
        .sendMessage(chatId, state.base + remoteProgressText(state), { inline_keyboard: buildKeyboard(state) })
        .then(({ message_id }) => {
            state.messageId = message_id;
            void poll();
        })
        .catch(() => {});

    return {
        result,
        settledRemotely(summaryLines: string[]) {
            if (settled || state.messageId === 0) return;
            settled = true;
            edit(`${state.base}\n\n${summaryLines.join("\n")}\n\n<b>⌨️ answered at the terminal</b>`);
        },
        closedExternally(reason: string) {
            if (settled || state.messageId === 0) return;
            settled = true;
            edit(`${state.base}\n\n⚪ ${escapeHtml(reason)}`);
        },
    };
}

// ---------------------------------------------------------------------------
// Layer A — local fallback walker (abortable pi dialogs; M0c)
// ---------------------------------------------------------------------------

const LOCAL_CUSTOM = "Type something…";
const LOCAL_DONE = "✓ Done";

export async function runLocalWalker(
    ctx: ExtensionContext,
    params: QuestionParams,
    signal: AbortSignal,
): Promise<QuestionnaireResult | "aborted"> {
    const answers: QuestionAnswer[] = [];
    const cancel = (): QuestionnaireResult | "aborted" =>
        signal.aborted ? "aborted" : { answers, cancelled: true };

    for (let i = 0; i < params.questions.length; i++) {
        const q = params.questions[i];
        const prefix = `[${i + 1}/${params.questions.length}]`;

        if (q.multiSelect) {
            const chosen: number[] = [];
            for (;;) {
                const chosenLabels = chosen.map((j) => q.options[j].label).join(", ") || "none";
                const labels = [...q.options.map((o) => o.label), LOCAL_DONE, LOCAL_CUSTOM];
                const pick = await ctx.ui.select(`${prefix} ${q.question} — selected: ${chosenLabels}`, labels, { signal });
                if (pick === undefined) return cancel();
                if (pick === LOCAL_DONE) break;
                if (pick === LOCAL_CUSTOM) {
                    const text = await ctx.ui.input(`${prefix} ${q.question} — custom answer`, undefined, { signal });
                    if (text === undefined) return cancel();
                    answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: text });
                    break;
                }
                const idx = q.options.findIndex((o) => o.label === pick);
                if (idx === -1) continue;
                const at = chosen.indexOf(idx);
                if (at === -1) chosen.push(idx);
                else chosen.splice(at, 1);
            }
            if (answers.some((a) => a.questionIndex === i)) continue; // custom replaced toggles
            chosen.sort((a, b) => a - b);
            answers.push({ questionIndex: i, question: q.question, kind: "multi", answer: null, selected: chosen.map((j) => q.options[j].label) });
            continue;
        }

        const labels = [...q.options.map((o) => o.label), LOCAL_CUSTOM];
        const pick = await ctx.ui.select(`${prefix} ${q.question}`, labels, { signal });
        if (pick === undefined) return cancel();
        if (pick === LOCAL_CUSTOM) {
            const text = await ctx.ui.input(`${prefix} ${q.question} — custom answer`, undefined, { signal });
            if (text === undefined) return cancel();
            answers.push({ questionIndex: i, question: q.question, kind: "custom", answer: text });
            continue;
        }
        const idx = q.options.findIndex((o) => o.label === pick);
        answers.push({
            questionIndex: i,
            question: q.question,
            kind: "option",
            answer: q.options[idx].label,
            ...(typeof q.options[idx].preview === "string" && q.options[idx].preview ? { preview: q.options[idx].preview } : {}),
        });
    }
    return { answers, cancelled: false };
}

// ---------------------------------------------------------------------------
// Layer A — the shadow tool
// ---------------------------------------------------------------------------

export interface ShadowToolDeps {
    getChat: () => { client: TelegramClient; chatId: string } | undefined;
    notify: (message: string, level: "info" | "error") => void;
    host?: string;
}

export const ASK_USER_QUESTION_TOOL_NAME = "ask_user_question";

const ERROR_NO_UI = "Error: UI not available (running in non-interactive mode)";

export function buildShadowToolDefinition(pi: ExtensionAPI, deps: ShadowToolDeps) {
    return {
        name: ASK_USER_QUESTION_TOOL_NAME,
        label: "Ask User Question",
        description: TOOL_DESCRIPTION,
        promptSnippet: PROMPT_SNIPPET,
        promptGuidelines: PROMPT_GUIDELINES,
        parameters: QuestionParamsSchema,
        async execute(_toolCallId: string, rawParams: unknown, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) {
            const params = (Array.isArray((rawParams as QuestionParams)?.questions) ? rawParams : { questions: [] }) as QuestionParams;

            if (!ctx.hasUI) {
                return buildToolResult(ERROR_NO_UI, { answers: [], cancelled: true, error: "no_ui" });
            }
            const validation = validateQuestionnaire(params);
            if (!validation.ok) {
                return buildToolResult(validation.message, { answers: [], cancelled: true, error: validation.error });
            }

            // Ecosystem-compat events (rpiv contract): prompt + blocked bracket.
            pi.events.emit("rpiv:ask-user:prompt", {
                questions: params.questions.map((q) => ({
                    question: q.question,
                    header: q.header,
                    multiSelect: q.multiSelect ?? false,
                    options: q.options.map((o) => ({ label: o.label, description: o.description, hasPreview: typeof o.preview === "string" && o.preview.length > 0 })),
                })),
            });
            pi.events.emit("rpiv:ask-user:blocked", { active: true });

            const race = new AbortController();
            const onAgentAbort = () => race.abort();
            signal?.addEventListener("abort", onAgentAbort, { once: true });

            try {
                if (process.stdout.isTTY) process.stdout.write("\x07"); // terminal attention, rpiv parity

                const chat = deps.getChat();
                const remote = chat
                    ? startRemoteSession({
                          client: chat.client,
                          chatId: chat.chatId,
                          base: renderQuestionnaireMessage({
                              args: params as unknown as QuestionnaireArgs,
                              host: deps.host ?? hostname(),
                              project: basename(ctx.cwd),
                              sessionName: ctx.sessionManager.getSessionName() ?? undefined,
                              mode: "interactive",
                          }),
                          params,
                          signal: race.signal,
                      })
                    : undefined;

                // Remote dismissal/failure must never settle the race — only a
                // complete remote answer or any local outcome may. `pending` is the
                // never-settles branch for that.
                const pending = new Promise<{ kind: "remote"; result: QuestionnaireResult }>(() => {});
                const remoteOutcome: Promise<{ kind: "remote"; result: QuestionnaireResult }> = remote
                    ? remote.result.then((result) => ({ kind: "remote" as const, result })).catch(() => pending)
                    : pending;
                const localOutcome = runLocalWalker(ctx, params, race.signal)
                    .then((r) => (r === "aborted" ? { kind: "none" as const } : { kind: "local" as const, result: r }))
                    .catch(() => ({ kind: "none" as const }));

                const winner = await Promise.race([remoteOutcome, localOutcome]);

                race.abort();
                if (winner.kind === "remote") {
                    return buildQuestionnaireResponse(winner.result, params);
                }
                if (winner.kind === "local") {
                    remote?.settledRemotely(
                        winner.result.answers.map(
                            (a) => `✅ ${escapeHtml(oneLine(a.question, 60))} → ${escapeHtml(oneLine(formatAnswerScalar(a), 80))}`,
                        ),
                    );
                    return buildQuestionnaireResponse(winner.result, params);
                }
                // none: agent abort or local crash — decline, close the Telegram side.
                remote?.closedExternally("turn ended");
                return buildQuestionnaireResponse(null, params);
            } finally {
                signal?.removeEventListener("abort", onAgentAbort);
                pi.events.emit("rpiv:ask-user:blocked", { active: false });
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Extension wiring
// ---------------------------------------------------------------------------

const SAMPLE_ARGS: QuestionnaireArgs = {
    questions: [
        {
            question: "Which library should we use for date formatting?",
            header: "Library",
            options: [
                { label: "date-fns", description: "Functional, tree-shakeable" },
                { label: "Luxon", description: "Immutable, timezone-first" },
            ],
        },
        {
            question: "Which checks should run?",
            header: "Checks",
            multiSelect: true,
            options: [
                { label: "typecheck", description: "tsc --noEmit" },
                { label: "smoke", description: "stub-render tests" },
            ],
        },
    ],
};

export default function (pi: ExtensionAPI) {
    if (process.env.HERDR_ENV !== "1") {
        return;
    }

    let notifier: Notifier | undefined;
    let lastNotify: ((message: string, level: "info" | "error") => void) | undefined;
    let shadowRegistered = false;

    const getChat = (): { client: TelegramClient; chatId: string } | undefined => {
        const { config } = loadConfig();
        if (!config || !config.enabled) return undefined;
        return { client: createTelegramClient(config.botToken), chatId: config.chatId };
    };

    /**
     * Register the same-name shadow when enabled. M0a: our load-time registration
     * deterministically wins over the rpiv npm package (packages resolve before
     * local extensions). Post-load re-registration (setup, /telegram on) also wins
     * — last write takes the name. There is no unregister: after /telegram off a
     * /reload is needed to restore the original rpiv tool.
     */
    const syncShadow = (): void => {
        const { config } = loadConfig();
        if (!config?.enabled) return;
        pi.registerTool(
            buildShadowToolDefinition(pi, {
                getChat,
                notify: (message, level) => lastNotify?.(message, level),
                host: hostname(),
            }) as Parameters<ExtensionAPI["registerTool"]>[0],
        );
        shadowRegistered = true;
    };

    const activate = (): void => {
        const { config } = loadConfig();
        if (!config || !config.enabled) {
            notifier = undefined;
            return;
        }
        notifier = createNotifier({
            client: createTelegramClient(config.botToken),
            chatId: config.chatId,
            notify: (message, level) => {
                lastNotify?.(message, level);
            },
        });
    };

    const ensureNotifier = (ctx: ExtensionContext): void => {
        lastNotify ??= (message, level) => ctx.ui.notify(message, level);
        // Re-activate whenever absent: first use, or after /telegram on|off reset it.
        if (!notifier) activate();
    };

    // Load-time shadow registration (must run before any question can fire).
    syncShadow();

    pi.on("tool_execution_start", (event, ctx) => {
        ensureNotifier(ctx);
        // The shadow's interactive message supersedes the plain notification —
        // never send both for the same question.
        if (shadowRegistered) return;
        notifier?.onToolStart(event, ctx);
    });
    pi.on("tool_execution_end", (event) => {
        if (shadowRegistered) return;
        notifier?.onToolEnd(event);
    });
    pi.on("agent_end", () => {
        notifier?.drain();
    });
    pi.on("session_shutdown", () => {
        notifier?.drain();
    });

    pi.registerCommand("telegram", {
        description: "Herdr Telegram bridge: setup, status, on/off, test",
        handler: async (args: string, ctx) => {
            const sub = args.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
            switch (sub) {
                case "setup":
                    await runSetup(ctx, () => syncShadow());
                    return;
                case "on":
                case "off": {
                    const { config, source } = loadConfig();
                    if (!config) {
                        ctx.ui.notify("No config — run /telegram setup first.", "error");
                        return;
                    }
                    if (source === "env") {
                        ctx.ui.notify("Config comes from env vars — /telegram on|off only works with a config file.", "error");
                        return;
                    }
                    writeConfigFile({ ...config, enabled: sub === "on" });
                    notifier = undefined; // re-activate lazily with fresh config
                    if (sub === "on") {
                        syncShadow();
                        ctx.ui.notify("Telegram enabled — ask_user_question is now answered remotely or at the terminal.", "info");
                    } else {
                        // No unregister API exists; our shadow keeps serving the name in
                        // local-only mode until a /reload re-evaluates the extension.
                        ctx.ui.notify("Telegram disabled. Note: run /reload to fully restore the original ask_user_question tool (until then it falls back to local-only dialogs).", "info");
                    }
                    return;
                }
                case "test": {
                    const { config } = loadConfig();
                    if (!config || !config.enabled) {
                        ctx.ui.notify("Telegram not configured/enabled — run /telegram setup.", "error");
                        return;
                    }
                    const client = createTelegramClient(config.botToken);
                    try {
                        const text = renderQuestionnaireMessage({
                            args: SAMPLE_ARGS,
                            host: hostname(),
                            project: basename(ctx.cwd),
                            sessionName: ctx.sessionManager.getSessionName() ?? undefined,
                        });
                        const { message_id } = await client.sendMessage(config.chatId, text);
                        await new Promise((r) => setTimeout(r, 1500));
                        await client.editMessageText(
                            config.chatId,
                            message_id,
                            `${text}\n\n<b>✅ resolved (test)</b>`,
                        );
                        ctx.ui.notify("Test message sent and edited — check Telegram.", "info");
                    } catch (err) {
                        ctx.ui.notify(`telegram test failed: ${err instanceof Error ? err.message : String(err)}`, "error");
                    }
                    return;
                }
                default: {
                    // status (also the no-arg help)
                    const { config, source, split } = loadConfig();
                    const lines = [
                        `herdr: ${process.env.HERDR_ENV === "1" ? "yes" : "no (extension inert)"}`,
                        `config: ${source}${split ? " (partial env config: set both TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID)" : ""}`,
                        `token: ${config ? "set" : "missing"} · chat: ${config?.chatId ? "set" : "missing"} · enabled: ${config?.enabled ?? false}`,
                        `tool: ${shadowRegistered ? "shadowed — answer via Telegram or terminal" : config?.enabled ? "notify-only (shadow will register on /reload)" : "original rpiv tool untouched"}`,
                        `file: ${CONFIG_PATH}`,
                    ];
                    ctx.ui.notify(lines.join("\n"), "info");
                    return;
                }
            }
        },
    });
}

// ---------------------------------------------------------------------------
// /telegram setup
// ---------------------------------------------------------------------------

async function runSetup(ctx: ExtensionContext, onSuccess?: () => void): Promise<void> {
    const existing = readConfigFile();

    const tokenInput = (await ctx.ui.input(
        `Bot token from @BotFather${existing ? " (empty = keep current)" : ""}`,
    ))?.trim();
    if (tokenInput === undefined) return; // cancelled
    const botToken = tokenInput || existing?.botToken;
    if (!botToken) {
        ctx.ui.notify("Setup aborted — no token.", "error");
        return;
    }

    let me: { id: number; username: string };
    try {
        me = await createTelegramClient(botToken).getMe();
    } catch (err) {
        ctx.ui.notify(`Token check failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
    }

    ctx.ui.notify(`Token OK (@${me.username}). Now send /start to @${me.username} in Telegram — waiting 90s…`, "info");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90_000);
    try {
        const client = createTelegramClient(botToken);
        let offset = 0;
        const deadline = Date.now() + 90_000;
        let chatId: string | undefined;
        while (chatId === undefined && Date.now() < deadline) {
            const updates = await client.getUpdates(offset, 25, ac.signal).catch((err: unknown) => {
                if (ac.signal.aborted) return [];
                throw err;
            });
            for (const u of updates) {
                offset = u.update_id + 1;
                const chat = u.message?.chat;
                if (u.message?.text?.trim() === "/start" && chat?.type === "private") {
                    chatId = String(chat.id);
                    break;
                }
            }
        }
        if (!chatId) {
            ctx.ui.notify("No /start received in 90s — setup aborted, nothing saved.", "error");
            return;
        }
        await client.sendMessage(chatId, "✅ herdr-telegram-ask connected — pi will message you here when it needs input.");
        writeConfigFile({ botToken, chatId, enabled: true });
        onSuccess?.();
        ctx.ui.notify(`Saved ${CONFIG_PATH} (0600). ask_user_question is now answered remotely or at the terminal — /telegram test to verify.`, "info");
    } catch (err) {
        ctx.ui.notify(`Setup failed: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
        clearTimeout(timer);
    }
}
