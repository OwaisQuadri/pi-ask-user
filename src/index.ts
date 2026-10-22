import type { ExtensionAPI, ExtensionContext, CustomMessageEntryDraft } from "@earendil-works/pi-coding-agent";
import { randomBytes, randomUUID } from "node:crypto";
import { access, rm, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { guidanceForContinuation, guidanceForQuestion, nativeActiveWork, isAutonomousScope, isQuestionPolicy, type AutonomousApproval, type AutonomousScope } from "./autonomous.ts";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	Editor,
	getNativeClipboard,
	type EditorTheme,
	Key,
	Text,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";


interface AskOption {
	label: string;
	value: string;
	description?: string;
}

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	otherIndex?: number;
	isOther?: boolean;
	isOtherAnswer?: boolean;
	isAddOther?: boolean;
	isSubmit?: boolean;
}

interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
type AskUserQuestionStatus = "answered" | "cancelled" | "invalid" | "unavailable" | "policy-guidance";
type AskUserQuestionMode = "text" | "single-select" | "multi-select";

interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
	isSecret?: boolean;
	provenance?: "interactive-user" | "automatic-policy-guidance";
	approvalId?: string;
}

const SECRET_CHANNEL = "ask-user-question:secret";
const secrets: Map<string, string> = (globalThis as any).__piAskUserSecrets ??= new Map<string, string>();

const RPC_PING_CHANNEL = "ask-user-question:rpc:ping";
const RPC_ASK_CHANNEL = "ask-user-question:rpc:ask";
const RPC_VERSION = 1;

const OptionSchema = Type.Object({
	label: Type.String({
		description:
			'Display label for the option. If you recommend an option, place it first and append "(Recommended)" to the label.',
	}),
	value: Type.Optional(
		Type.String({
			description: "Optional machine-readable value returned for the option. Defaults to the label.",
		}),
	),
	description: Type.Optional(Type.String({ description: "Optional extra detail shown below the option." })),
});

const ProtectedActionSchema = Type.Object({
	action: Type.String(),
	target: Type.String(),
	bounds: Type.String({ description: "Exact bounds, not a wildcard or a request for new authority." }),
}, { additionalProperties: false });

const AutonomousScopeSchema = Type.Object({
	taskId: Type.String(),
	scope: Type.String(),
	protectedActions: Type.Array(ProtectedActionSchema),
	principleSources: Type.Array(Type.String({ description: "Existing readable owner file path. No secrets or policy copies." })),
	expiresAt: Type.String({ description: "Finite ISO date-time. Approval also expires at task completion." }),
}, { additionalProperties: false });

const QuestionPolicySchema = Type.Object({
	taskId: Type.String(),
	scope: Type.String({ description: "Exact approved task scope. Metadata never grants authority." }),
	kind: Type.Union([Type.Literal("routine"), Type.Literal("protected"), Type.Literal("approval")]),
	isReversible: Type.Optional(Type.Boolean()),
	protectedAction: Type.Optional(ProtectedActionSchema),
}, { additionalProperties: false });

const AskUserQuestionParams = Type.Object({
	question: Type.String({
		description: "The single question to ask the user. Ask exactly one question per tool call.",
	}),
	details: Type.Optional(
		Type.String({
			description: "Optional extra context or instructions shown under the question.",
		}),
	),
	options: Type.Optional(
		Type.Array(OptionSchema, {
			description:
				"Optional multiple-choice options. Omit or pass an empty array for free-form text input. Users will always be able to choose Other and type a custom answer when options are provided.",
		}),
	),
	multiSelect: Type.Optional(
		Type.Boolean({
			description: "Set to true to allow multiple answers to be selected for a question.",
		}),
	),
	policy: Type.Optional(QuestionPolicySchema),
	secure: Type.Optional(
		Type.Boolean({
			description:
				"Set to true to collect a secret, such as an API key or password. You never see the value; you get a handle such as {{secret:3f9a01bc}} that only secret-aware tools accept. Free text only: do not pass options.",
		}),
	),
});

type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;

function isAskUserQuestionInput(value: unknown): value is AskUserQuestionInput {
	if (value === null || typeof value !== "object") return false;
	const input = value as Record<string, unknown>;
	if (typeof input.question !== "string" || input.question.trim().length === 0) return false;
	if (input.details !== undefined && typeof input.details !== "string") return false;
	if (input.multiSelect !== undefined && typeof input.multiSelect !== "boolean") return false;
	if (input.secure !== undefined && typeof input.secure !== "boolean") return false;
	if (input.policy !== undefined && !isQuestionPolicy(input.policy)) return false;
	if (input.options === undefined) return true;
	if (!Array.isArray(input.options)) return false;
	return input.options.every((option) => {
		if (option === null || typeof option !== "object") return false;
		const item = option as Record<string, unknown>;
		return typeof item.label === "string"
			&& (item.value === undefined || typeof item.value === "string")
			&& (item.description === undefined || typeof item.description === "string");
	});
}

interface AskUserQuestionRpcRequest {
	requestId: string;
	params: AskUserQuestionInput;
	signal?: AbortSignal;
}

function isAbortSignal(value: unknown): value is AbortSignal {
	if (value === null || typeof value !== "object") return false;
	const signal = value as Record<string, unknown>;
	return typeof signal.aborted === "boolean"
		&& typeof signal.addEventListener === "function"
		&& typeof signal.removeEventListener === "function";
}

function normalizeOptions(options: Array<{ label: string; value?: string; description?: string }> | undefined): AskOption[] {
	return (options || [])
		.map((option) => ({
			label: option.label.trim(),
			value: option.value?.trim() || option.label.trim(),
			description: option.description?.trim() || undefined,
		}))
		.filter((option) => option.label.length > 0);
}

function hasMinimumChoiceCount(options: AskOption[]): boolean {
	return options.length >= 2;
}

function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function buildOptionItems(options: AskOption[]): DisplayOption[] {
	return options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
}

function buildChoiceItems(options: AskOption[]): DisplayOption[] {
	return [
		...buildOptionItems(options),
		{ id: "other", label: getOtherLabel(options), value: "__other__", isOther: true },
	];
}

function buildMultiChoiceItems(options: AskOption[], otherAnswers: OtherAnswer[]): DisplayOption[] {
	return [
		...buildOptionItems(options),
		...otherAnswers.map((answer, index) => ({
			...answer,
			id: `other:${index}`,
			otherIndex: index,
			isOtherAnswer: true,
		})),
		{ id: "add-other", label: "Add Other", value: "__other__", isAddOther: true },
		{ id: "submit", label: "Submit", value: "__submit__", isSubmit: true },
	];
}

function createEditorTheme(theme: any): EditorTheme {
	return {
		borderColor: (s) => theme.fg("accent", s),
		selectList: {
			selectedPrefix: (t) => theme.fg("accent", t),
			selectedText: (t) => theme.fg("accent", t),
			description: (t) => theme.fg("muted", t),
			scrollInfo: (t) => theme.fg("dim", t),
			noMatch: (t) => theme.fg("warning", t),
		},
	};
}

async function pasteClipboardIntoEditor(editor: Editor, isActive: () => boolean, refresh: () => void): Promise<void> {
	try {
		const clipboard = getNativeClipboard();
		if (!clipboard) return;
		const image = await clipboard.getImage();
		if (!isActive()) return;
		if (image?.length) {
			const bytes = Buffer.from(image);
			const extension = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "png"
				: bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? "jpg"
				: bytes.toString("ascii", 0, 3) === "GIF" ? "gif"
				: bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "webp"
				: undefined;
			if (extension) {
				const path = join(tmpdir(), `pi-clipboard-${randomUUID()}.${extension}`);
				await writeFile(path, bytes);
				if (!isActive()) {
					await rm(path, { force: true });
					return;
				}
				editor.insertTextAtCursor(path);
				refresh();
				return;
			}
		}
		const text = await clipboard.getText();
		if (text && isActive()) {
			editor.insertTextAtCursor(text);
			refresh();
		}
	} catch {
		return;
	}
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function formatAnswerForModel(answer: AskAnswer): string {
	switch (answer.type) {
		case "text":
			return answer.label;
		case "other":
			return `Other: ${answer.label}`;
		case "option":
			return `${answer.index}. ${answer.label}`;
	}
}

function answerSortRank(answer: AskAnswer): number {
	switch (answer.type) {
		case "option":
			return answer.index;
		case "other":
			return Number.MAX_SAFE_INTEGER - 1;
		case "text":
			return Number.MAX_SAFE_INTEGER;
	}
}

function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((a, b) => answerSortRank(a) - answerSortRank(b));
}

function buildStructuredResult(
	status: AskUserQuestionStatus,
	question: string,
	mode: AskUserQuestionMode,
	answers: AskAnswer[],
	context?: string,
	message?: string,
) {
	return {
		status,
		question,
		context,
		mode,
		answers,
		message,
		...(status === "answered" ? { provenance: "interactive-user" as const } : {}),
	} as AskUserQuestionResultDetails;
}

function cancelledResult(question: string, mode: AskUserQuestionMode, context?: string) {
	const message = "User cancelled the question";
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("cancelled", question, mode, [], context, message),
	};
}

function unavailableResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("unavailable", question, mode, [], context, message),
	};
}

function invalidResult(question: string, mode: AskUserQuestionMode, message: string, context?: string) {
	return {
		content: [{ type: "text" as const, text: message }],
		details: buildStructuredResult("invalid", question, mode, [], context, message),
	};
}

function buildResult(question: string, context: string | undefined, mode: AskUserQuestionMode, answers: AskAnswer[]) {
	let text: string;
	if (mode === "text") {
		const answer = answers[0];
		text = answer.label.trim().length > 0 ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (mode === "single-select") {
		text = `User selected: ${formatAnswerForModel(answers[0])}`;
	} else {
		text = `User selected:\n${answers.map((answer) => `- ${formatAnswerForModel(answer)}`).join("\n")}`;
	}

	return {
		content: [{ type: "text" as const, text }],
		details: buildStructuredResult("answered", question, mode, answers, context),
	};
}

function secretResult(question: string, context: string | undefined, handle: string) {
	return {
		content: [{ type: "text" as const, text: `User entered a secret. You cannot see it. Its handle is ${handle}; pass the handle to a tool that accepts secret handles.` }],
		details: { ...buildStructuredResult("answered", question, "text", [{ type: "text", label: handle, value: handle }], context), isSecret: true },
	};
}

function redactSecrets(text: string): string {
	let result = text;
	const entries = [...secrets].filter(([, value]) => value.length >= 8).sort(([, a], [, b]) => b.length - a.length);
	for (const [handle, value] of entries) result = result.split(value).join(handle);
	return result;
}

function redactDeep<T>(value: T): T {
	if (typeof value === "string") return redactSecrets(value) as T;
	if (Array.isArray(value)) return value.map(redactDeep) as T;
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item)])) as T;
	}
	return value;
}

async function askFreeText(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	signal: AbortSignal | undefined,
	isSecure = false,
): Promise<string | undefined> {
	if (ctx.mode === "rpc") {
		const title = context ? `${question}\n\n${context}` : question;
		return ctx.ui.editor(isSecure ? `Secret: the agent gets a handle, not the value.\n\n${title}` : title, "");
	}

	return ctx.ui.custom<string | undefined>((tui: any, theme: any, _kb: any, done: (result: string | undefined) => void) => {
		let isDone = false;
		const finish = (result: string | undefined) => {
			if (isDone) return;
			isDone = true;
			signal?.removeEventListener("abort", onAbort);
			done(result);
		};
		const onAbort = () => finish(undefined);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();

		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		let isMasked = false;
		const editor = new Editor(tui, createEditorTheme(theme));
		editor.onSubmit = finish;

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function render(width: number): string[] {
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");
			if (isSecure && isMasked) add(` ${theme.fg("text", "•".repeat(editor.getText().length))}`);
			else for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
			lines.push("");
			add(theme.fg("dim", isSecure
				? ` Secret: the agent gets a handle, not the value • Ctrl+T ${isMasked ? "show" : "hide"} • Enter submit • Esc cancel`
				: " Shift+Enter newline • Enter submit • Esc cancel"));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.escape)) {
					finish(undefined);
					return;
				}
				if (matchesKey(data, Key.ctrl("v"))) {
					void pasteClipboardIntoEditor(editor, () => !isDone, refresh);
					return;
				}
				if (isSecure && matchesKey(data, Key.ctrl("t"))) {
					isMasked = !isMasked;
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
			},
			dispose() {
				finish(undefined);
			},
		};
	});
}

async function askSingleChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	signal: AbortSignal | undefined,
): Promise<AskAnswer | null> {
	const allOptions = buildChoiceItems(options);

	return ctx.ui.custom<AskAnswer | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer | null) => void) => {
		let isDone = false;
		const finish = (result: AskAnswer | null) => {
			if (isDone) return;
			isDone = true;
			signal?.removeEventListener("abort", onAbort);
			done(result);
		};
		const onAbort = () => finish(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const editor = new Editor(tui, createEditorTheme(theme));

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			finish({ type: "other", label: trimmed, value: trimmed });
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				if (matchesKey(data, Key.ctrl("v"))) {
					void pasteClipboardIntoEditor(editor, () => !isDone && editMode, refresh);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
					refresh();
					return;
				}
				finish({
					type: "option",
					label: selected.label,
					value: selected.value,
					index: selected.index!,
				});
				return;
			}
			if (matchesKey(data, Key.escape)) {
				finish(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			for (let i = 0; i < allOptions.length; i++) {
				const option = allOptions[i];
				const selected = i === optionIndex;
				const prefix = selected ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
				const styled = selected ? theme.fg("accent", label) : theme.fg("text", label);
				add(`${prefix}${styled}`);
				if (option.description) {
					addWrapped(lines, theme.fg("muted", option.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to go back"));
			} else {
				lines.push("");
				add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose() {
				finish(null);
			},
		};
	});
}

async function askMultiChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	signal: AbortSignal | undefined,
): Promise<AskAnswer[] | null> {
	return ctx.ui.custom<AskAnswer[] | null>((tui: any, theme: any, _kb: any, done: (result: AskAnswer[] | null) => void) => {
		let isDone = false;
		const finish = (result: AskAnswer[] | null) => {
			if (isDone) return;
			isDone = true;
			signal?.removeEventListener("abort", onAbort);
			done(result);
		};
		const onAbort = () => finish(null);
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		let optionIndex = 0;
		let editMode = false;
		let editingOtherIndex: number | undefined;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const selected = new Map<string, OptionAnswer>();
		let otherAnswers: OtherAnswer[] = [];
		const editor = new Editor(tui, createEditorTheme(theme));

		function getItems(): DisplayOption[] {
			return buildMultiChoiceItems(options, otherAnswers);
		}

		function openOtherEditor(otherIndex?: number) {
			editingOtherIndex = otherIndex;
			editMode = true;
			editor.setText(otherIndex === undefined ? "" : otherAnswers[otherIndex]!.value);
			refresh();
		}

		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;

			const duplicateIndex = otherAnswers.findIndex((answer, index) =>
				index !== editingOtherIndex && answer.value.localeCompare(trimmed, undefined, { sensitivity: "accent" }) === 0,
			);
			if (duplicateIndex === -1) {
				const answer: OtherAnswer = { type: "other", label: trimmed, value: trimmed };
				if (editingOtherIndex === undefined) {
					otherAnswers = [...otherAnswers, answer];
					optionIndex = options.length + otherAnswers.length;
				} else {
					otherAnswers = otherAnswers.map((otherAnswer, index) => index === editingOtherIndex ? answer : otherAnswer);
					optionIndex = options.length + editingOtherIndex;
				}
			}
			editMode = false;
			editingOtherIndex = undefined;
			editor.setText("");
			refresh();
		};

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function toggleOption(item: DisplayOption) {
			if (selected.has(item.id)) {
				selected.delete(item.id);
			} else {
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index!,
				});
			}
			refresh();
		}

		function handleInput(data: string) {
			if (editMode) {
				if (matchesKey(data, Key.escape)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				if (matchesKey(data, Key.ctrl("v"))) {
					void pasteClipboardIntoEditor(editor, () => !isDone && editMode, refresh);
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(getItems().length - 1, optionIndex + 1);
				refresh();
				return;
			}

			const current = getItems()[optionIndex]!;
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit) return;
				if (current.isOtherAnswer) {
					otherAnswers = otherAnswers.filter((_, index) => index !== current.otherIndex);
					refresh();
					return;
				}
				if (current.isAddOther) {
					openOtherEditor();
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.enter)) {
				if (current.isSubmit) {
					const answers = [...selected.values(), ...otherAnswers];
					if (answers.length > 0) {
						finish(sortAnswers(answers));
					}
					return;
				}
				if (current.isOtherAnswer) {
					openOtherEditor(current.otherIndex);
					return;
				}
				if (current.isAddOther) {
					openOtherEditor();
					return;
				}
				toggleOption(current);
				return;
			}

			if (matchesKey(data, Key.escape)) {
				finish(null);
			}
		}

		function render(width: number): string[] {
			// The cache MUST be keyed on width: pi-tui calls requestRender() but NOT
			// invalidate() on terminal resize, so render() can be re-entered with a
			// new width. Returning stale wider lines trips the TUI width guard and
			// crashes the process.
			if (cachedLines && cachedWidth === width) return cachedLines;

			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));

			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");

			const allItems = getItems();
			for (let i = 0; i < allItems.length; i++) {
				const item = allItems[i]!;
				const isFocused = i === optionIndex;
				const prefix = isFocused ? theme.fg("accent", "> ") : "  ";

				if (item.isSubmit) {
					const selectedCount = selected.size + otherAnswers.length;
					const label = selectedCount > 0 ? `✓ ${item.label} (${selectedCount} selected)` : `○ ${item.label}`;
					const styled = isFocused
						? theme.fg("accent", label)
						: theme.fg(selectedCount > 0 ? "success" : "dim", label);
					add(`${prefix}${styled}`);
					continue;
				}

				if (item.isOtherAnswer) {
					const label = `[x] Other: ${item.label}`;
					const styled = isFocused ? theme.fg("accent", label) : theme.fg("success", label);
					add(`${prefix}${styled}`);
					continue;
				}

				if (item.isAddOther) {
					const label = `[ ] ${item.label}`;
					const styled = isFocused ? theme.fg("accent", label) : theme.fg("text", label);
					add(`${prefix}${styled}`);
					continue;
				}

				const checked = selected.has(item.id);
				const marker = checked ? "[x]" : "[ ]";
				const label = `${marker} ${item.index}. ${item.label}`;
				const styled = isFocused
					? theme.fg("accent", label)
					: theme.fg(checked ? "success" : "text", label);
				add(`${prefix}${styled}`);
				if (item.description) {
					addWrapped(lines, theme.fg("muted", item.description), width, "     ");
				}
			}

			if (editMode) {
				lines.push("");
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) {
					add(` ${line}`);
				}
				lines.push("");
				add(theme.fg("dim", " Enter to save • Esc to go back"));
			} else {
				lines.push("");
				if (selected.size + otherAnswers.length === 0) {
					add(theme.fg("warning", " Select at least one answer before submitting."));
				}
				add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel"));
			}

			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		}

		return {
			render,
			invalidate: () => {
				cachedLines = undefined;
			},
			handleInput,
			dispose() {
				finish(null);
			},
		};
	});
}

// Shared UI mutex. ctx.ui.custom()/editor can only handle one active call at
// a time, so ALL pop-up-style tools (ask_user_question, quiz, ...) must
// serialize against each other, not just against themselves. We stash one
// mutex on globalThis so separate extension files can share it without
// importing each other.
const SHARED_UI_LOCK_KEY = "__piSharedUiLock";
function getSharedUiLock() {
	const g = globalThis as any;
	if (!g[SHARED_UI_LOCK_KEY]) {
		let chain: Promise<void> = Promise.resolve();
		g[SHARED_UI_LOCK_KEY] = {
			withLock<T>(fn: () => T | Promise<T>): Promise<T> {
				const prev = chain;
				let release: () => void;
				chain = new Promise<void>((r) => { release = r; });
				return prev.then(fn).finally(() => release!());
			},
		};
	}
	return g[SHARED_UI_LOCK_KEY] as { withLock<T>(fn: () => T | Promise<T>): Promise<T>; questionCount?: number };
}
const sharedUiLock = getSharedUiLock();

function withUILock<T>(fn: () => Promise<T>): Promise<T> {
	return sharedUiLock.withLock(fn);
}

async function executeQuestion(
	pi: ExtensionAPI,
	params: AskUserQuestionInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	isContextActive?: () => boolean,
	getGuidance?: () => { text: string; approvalId: string } | undefined,
) {
	const options = normalizeOptions(params.options);
	const context = params.details?.trim() || undefined;
	const mode: AskUserQuestionMode = options.length === 0 ? "text" : params.multiSelect ? "multi-select" : "single-select";

	if (params.secure && options.length > 0) {
		return invalidResult(params.question, mode, "ask_user_question secure questions are free text: do not pass options", context);
	}
	if (params.question.trim().length === 0) {
		return invalidResult(params.question, mode, "ask_user_question requires a non-blank question", context);
	}
	if (params.options !== undefined && params.options.length > 0 && !hasMinimumChoiceCount(options)) {
		return invalidResult(
			params.question,
			mode,
			"ask_user_question requires at least two non-blank options when options are supplied",
			context,
		);
	}
	if (signal?.aborted) return cancelledResult(params.question, mode, context);
	if (!ctx.hasUI) {
		return unavailableResult(params.question, mode, "ask_user_question requires interactive mode UI", context);
	}

	sharedUiLock.questionCount = (sharedUiLock.questionCount ?? 0) + 1;
	pi.events.emit("ask-user-question:activity", { isPending: true });
	try {
		return await withUILock(async () => {
		if (signal?.aborted) return cancelledResult(params.question, mode, context);
		if (isContextActive && !isContextActive()) {
			return unavailableResult(params.question, mode, "No active interactive session", context);
		}
		const guidance = getGuidance?.();
		if (guidance) {
			return {
				content: [{ type: "text" as const, text: guidance.text }],
				details: {
					...buildStructuredResult("policy-guidance", params.question, mode, [], context, guidance.text),
					provenance: "automatic-policy-guidance" as const,
					approvalId: guidance.approvalId,
				},
			};
		}
		pi.events.emit("herdr:blocked", { active: true, label: params.question });
		try {
			if (mode === "text" && params.secure) {
				const answer = (await askFreeText(ctx, params.question, context, signal, true))?.trim();
				if (!answer) return cancelledResult(params.question, mode, context);
				const handle = `{{secret:${randomBytes(4).toString("hex")}}}`;
				secrets.set(handle, answer);
				pi.events.emit(SECRET_CHANNEL, { handle, value: answer });
				return secretResult(params.question, context, handle);
			}
			if (mode === "text") {
				const answer = await askFreeText(ctx, params.question, context, signal);
				if (answer === undefined) return cancelledResult(params.question, mode, context);
				return buildResult(params.question, context, mode, [
					{ type: "text", label: answer.trim(), value: answer.trim() },
				]);
			}

			if (mode === "single-select") {
				const answer = await askSingleChoice(ctx, params.question, context, options, signal);
				if (!answer) return cancelledResult(params.question, mode, context);
				return buildResult(params.question, context, mode, [answer]);
			}

			const answers = await askMultiChoice(ctx, params.question, context, options, signal);
			if (!answers) return cancelledResult(params.question, mode, context);
			return buildResult(params.question, context, mode, answers);
		} finally {
			pi.events.emit("herdr:blocked", { active: false });
		}
		});
	} finally {
		sharedUiLock.questionCount = Math.max(0, (sharedUiLock.questionCount ?? 1) - 1);
		pi.events.emit("ask-user-question:activity", { isPending: sharedUiLock.questionCount > 0 });
	}
}

export default function askUserQuestion(pi: ExtensionAPI) {
	let activeContext: ExtensionContext | undefined;
	let isRpcOwner = false;
	let owningSessionId: string | undefined;
	let approval: AutonomousApproval | undefined;
	let approvalRevision = 0;
	let isNativeAdvertised = false;
	pi.events.on("subagents:rpc:v1:ready", () => { isNativeAdvertised = true; });
	const expireApproval = () => {
		approval = undefined;
		approvalRevision++;
	};
	const isOwningSession = (ctx: ExtensionContext) => ctx.mode === "tui" && ctx.hasUI
		&& activeContext !== undefined && owningSessionId === ctx.sessionManager.getSessionId();
	function currentApproval(ctx: ExtensionContext): AutonomousApproval | undefined {
		if (approval && Date.parse(approval.expiresAt) <= Date.now()) expireApproval();
		return isOwningSession(ctx) ? approval : undefined;
	}
	pi.on("session_start", (_event, ctx) => {
		expireApproval();
		activeContext = ctx.mode === "tui" ? ctx : undefined;
		owningSessionId = activeContext?.sessionManager.getSessionId();
		isRpcOwner = ctx.mode === "tui";
	});
	pi.on("session_before_switch", expireApproval);
	pi.on("session_before_fork", expireApproval);
	pi.on("session_before_tree", expireApproval);
	pi.on("session_shutdown", () => {
		expireApproval();
		activeContext = undefined;
	});

	function revokeForBlocker(ctx: ExtensionContext, current: AutonomousApproval, reason: string): CustomMessageEntryDraft {
		expireApproval();
		const content = `AUTONOMOUS BLOCKER: ${reason} Automation revoked; task ${current.taskId} is not marked complete.`;
		ctx.ui.notify(content, "error");
		return {
			type: "custom_message", customType: "autonomous-blocked", display: true, content,
			details: { provenance: "automatic-policy-guidance", approvalId: current.approvalId, taskId: current.taskId, isActive: false, isTaskComplete: false, reason },
		};
	}
	const isNativeBlocker = (customType: string) => customType === "subagent-supervisor-blocked"
		|| customType === "subagent-completion-unhandled";
	const isNativeExhausted = (ctx: ExtensionContext, current: AutonomousApproval) => ctx.sessionManager.getBranch()
		.some((entry) => entry.type === "custom_message" && isNativeBlocker(entry.customType)
			&& Date.parse(entry.timestamp) >= Date.parse(current.approvedAt));

	pi.on("agent_before_settle", async (event, ctx) => {
		const current = currentApproval(ctx);
		if (!current || event.outcome !== "completed") return;
		const signal = ctx.signal;
		const revision = approvalRevision;
		const isCurrent = () => !signal?.aborted && !ctx.signal?.aborted && currentApproval(ctx) === current
			&& approvalRevision === revision && ctx.sessionManager.getSessionId() === current.sessionId;
		if (!isCurrent()) return;
		if (isNativeExhausted(ctx, current)
			|| event.entries.some((entry) => entry.type === "custom_message" && isNativeBlocker(entry.customType))) {
			return { entries: [...event.entries, revokeForBlocker(ctx, current, "Native reminder budget exhausted.")] };
		}
		if (event.continue || event.context.pendingMessages.length || ctx.hasPendingMessages()) return;
		const messages = event.context.contextMessages;
		const nativeNoticeIndex = messages.findLastIndex((message) => message.role === "custom"
			&& ["subagent-notify", "subagent_supervisor_request", "subagent-completion-unanswered", "subagent-supervisor-unanswered"].includes(message.customType));
		const isNativeReminderPending = nativeNoticeIndex !== -1 && !messages.slice(nativeNoticeIndex + 1).some((message) => message.role === "assistant"
			&& message.content.some((part) => part.type === "toolCall" || (part.type === "text" && part.text.trim())));
		let totalActive: number;
		try {
			totalActive = await nativeActiveWork(pi, current.sessionId, () => isNativeAdvertised || isNativeReminderPending,
				() => isCurrent() && !ctx.hasPendingMessages() && !event.context.pendingMessages.length && !event.continue, signal);
		} catch (error) {
			if (!isCurrent() || ctx.hasPendingMessages() || event.context.pendingMessages.length) return;
			const reason = `Compatibility blocker: ${error instanceof Error ? error.message : "Native status unavailable."}`;
			return { entries: [...event.entries, revokeForBlocker(ctx, current, reason)] };
		}
		if (!isCurrent() || ctx.hasPendingMessages() || event.context.pendingMessages.length || event.continue
			|| totalActive > 0 || isNativeReminderPending) return;
		return {
			entries: [...event.entries, {
				type: "custom_message" as const, customType: "autonomous-continuation", display: true,
				content: guidanceForContinuation(current),
				details: { provenance: "automatic-policy-guidance", approvalId: current.approvalId, taskId: current.taskId },
			}],
			continue: true,
		};
	});
	pi.on("agent_settled", (_event, ctx) => {
		const current = currentApproval(ctx);
		if (!current) return;
		if (isNativeExhausted(ctx, current)) {
			const entry = revokeForBlocker(ctx, current, "Native reminder budget exhausted.");
			pi.appendEntry(entry.customType, entry.details);
		}
	});

	function modeResult(ctx: ExtensionContext, message?: string) {
		const current = currentApproval(ctx);
		return {
			content: [{ type: "text" as const, text: message || (current
				? `Autonomous policy guidance is on.\n${JSON.stringify(current, null, 2)}`
				: "Autonomous policy guidance is off.") }],
			details: { isActive: !!current, approval: current, message },
		};
	}

	async function enableMode(ctx: ExtensionContext, proposed: AutonomousScope | undefined, signal?: AbortSignal) {
		if (!isOwningSession(ctx)) return modeResult(ctx, "Enable autonomous mode in the owning interactive TUI session. Child and RPC sessions cannot inherit approval.");
		const revision = approvalRevision;
		const sessionId = ctx.sessionManager.getSessionId();
		return withUILock(async () => {
			const isCurrent = () => !signal?.aborted && isOwningSession(ctx)
				&& ctx.sessionManager.getSessionId() === sessionId && approvalRevision === revision;
			if (!isCurrent()) return modeResult(ctx, "Autonomous approval request expired or was cancelled.");
			pi.events.emit("herdr:blocked", { active: true, label: "Review autonomous scope" });
			try {
				const template = proposed || {
					taskId: "", scope: "", protectedActions: [], principleSources: [],
					expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
				};
				const edited = await ctx.ui.editor("Review autonomous scope (nonsecret JSON)", JSON.stringify(template, null, 2));
				if (edited === undefined || !isCurrent()) return modeResult(ctx, "Autonomous approval cancelled.");
				let value: unknown;
				try { value = JSON.parse(edited); } catch { return modeResult(ctx, "Invalid scope JSON. Autonomous approval unchanged."); }
				if (!isAutonomousScope(value) || Date.parse(value.expiresAt) <= Date.now()) {
					return modeResult(ctx, "Scope requires taskId, scope, exact protectedActions, existing principleSources, and a future expiresAt.");
				}
				const reviewed: AutonomousScope = {
					taskId: value.taskId, scope: value.scope, expiresAt: value.expiresAt,
					protectedActions: value.protectedActions.map(({ action, target, bounds }) => ({ action, target, bounds })),
					principleSources: value.principleSources.map((source) => resolve(ctx.cwd, source)),
				};
				try {
					for (const source of reviewed.principleSources) {
						await access(source, constants.R_OK);
						if (!(await stat(source)).isFile()) throw new Error("Not a file");
					}
				} catch {
					return modeResult(ctx, "Each principle source must be an existing readable owner file. Autonomous approval unchanged.");
				}
				if (!isCurrent()) return modeResult(ctx, "Autonomous approval request expired.");
				const isApproved = await ctx.ui.confirm("Approve autonomous policy guidance?", [
					JSON.stringify(reviewed, null, 2),
					"This replaces any earlier approval in this session. It expires at task completion or expiresAt, whichever comes first.",
					"Only approve nonsecret references and exact targets and bounds. No wildcard matching applies.",
					"This is not execution authorization or a sandbox. Credential controls, native prompts, command guards and human-only merges remain authoritative.",
					"Secure fields, new authority and expanded scope still require interaction. Children receive no approval.",
				].join("\n\n"));
				if (!isApproved || !isCurrent() || Date.parse(reviewed.expiresAt) <= Date.now()) return modeResult(ctx, "Autonomous approval not granted.");
				approval = {
					...reviewed, sessionId, approvalId: randomUUID(), approvedAt: new Date().toISOString(),
					provenance: "interactive-user", expiresOn: "task_complete",
				};
				approvalRevision++;
				return modeResult(ctx);
			} finally {
				pi.events.emit("herdr:blocked", { active: false });
			}
		});
	}

	pi.registerCommand("autonomous", {
		description: "Manage session-owned autonomous policy guidance",
		getArgumentCompletions(argumentText) {
			return [
				{ value: "on", label: "on", description: "Review task scope and request human approval" },
				{ value: "off", label: "off", description: "Revoke approval, including at task completion" },
				{ value: "status", label: "status", description: "Show this session's approval and expiry" },
			].filter((item) => item.value.startsWith(argumentText));
		},
		async handler(args, ctx) {
			const action = args.trim();
			if (action === "off" && isOwningSession(ctx)) expireApproval();
			const result = action === "on" ? await enableMode(ctx, undefined)
				: action === "off" || action === "status" ? modeResult(ctx)
				: modeResult(ctx, "Usage: /autonomous on|off|status");
			ctx.ui.notify(result.content[0].text, "info");
		},
	});

	pi.registerTool({
		name: "autonomous_mode",
		label: "Autonomous mode",
		description: "Request human-reviewed enablement or widening in the owning interactive session. Never approves itself. Report status locally. Use off and report a real blocker without declaring completion. Close a completed task explicitly with matching task_complete; approval is not execution authorization.",
		parameters: Type.Object({
			action: Type.Union([Type.Literal("on"), Type.Literal("off"), Type.Literal("status"), Type.Literal("task_complete")]),
			scope: Type.Optional(AutonomousScopeSchema),
			taskId: Type.Optional(Type.String({ description: "Required for task_complete; must match the active task." })),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			if (params.action === "on") return enableMode(ctx, params.scope, signal);
			if (params.action === "task_complete" && params.taskId !== currentApproval(ctx)?.taskId) {
				return modeResult(ctx, "task_complete requires the active taskId.");
			}
			if ((params.action === "off" || params.action === "task_complete") && isOwningSession(ctx)) expireApproval();
			return modeResult(ctx);
		},
	});
	pi.on("tool_result", (event) => {
		if (secrets.size === 0) return;
		try {
			const original = { content: event.content, structuredContent: event.structuredContent, details: event.details };
			const redacted = redactDeep(original);
			if (JSON.stringify(redacted) === JSON.stringify(original)) return;
			return { content: redacted.content, structuredContent: redacted.structuredContent, details: redacted.details ?? {} };
		} catch {
			return { content: [{ type: "text" as const, text: "pi-ask-user withheld this output because it could not remove a secret from it." }], structuredContent: undefined, details: {}, isError: true };
		}
	});
	pi.on("context", (event) => {
		if (secrets.size === 0) return;
		const messages = redactDeep(event.messages);
		if (JSON.stringify(messages) === JSON.stringify(event.messages)) return;
		return { messages };
	});
	pi.events.on(RPC_PING_CHANNEL, (payload) => {
		if (!isRpcOwner || payload === null || typeof payload !== "object") return;
		const { requestId } = payload as { requestId?: unknown };
		if (typeof requestId !== "string" || requestId.length === 0) return;
		const replyChannel = `${RPC_PING_CHANNEL}:reply:${requestId}`;
		if (!activeContext) {
			pi.events.emit(replyChannel, { success: false, error: "No active interactive session" });
			return;
		}
		pi.events.emit(replyChannel, {
			success: true,
			data: { version: RPC_VERSION },
		});
	});
	pi.events.on(RPC_ASK_CHANNEL, async (payload) => {
		if (!isRpcOwner || payload === null || typeof payload !== "object") return;
		const request = payload as AskUserQuestionRpcRequest;
		if (typeof request.requestId !== "string" || request.requestId.length === 0) return;
		const replyChannel = `${RPC_ASK_CHANNEL}:reply:${request.requestId}`;
		try {
			if (!activeContext) throw new Error("No active interactive session");
			if (!isAskUserQuestionInput(request.params)) throw new Error("Invalid ask_user_question parameters");
			if (request.signal !== undefined && !isAbortSignal(request.signal)) throw new Error("Invalid ask_user_question abort signal");
			const context = activeContext;
			const data = await executeQuestion(pi, request.params, request.signal, context, () => activeContext === context);
			pi.events.emit(replyChannel, { success: true, data });
		} catch (error) {
			pi.events.emit(replyChannel, {
				success: false,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	});

	pi.registerTool({
		name: "ask_user_question",
		label: "ask_user_question",
		description:
			"Ask the user a single question and pause execution until they answer. Use this when requirements are ambiguous, user preferences are needed, a decision would materially affect implementation, or you need confirmation before proceeding. Ask exactly one question per tool call, and prefer multiple separate tool calls over bundling unrelated questions together.",
		promptSnippet:
			"Use this tool to ask exactly one clarifying question, missing-requirement question, preference question, or decision question before continuing.",
		promptGuidelines: [
			"Ask exactly one question per tool call.",
			"Supply policy metadata only for the exact approved task. Ambiguous questions remain interactive.",
			"Use kind approval for enablement, widening, or requests for new authority. Never classify these as routine.",
			"Automatic POLICY GUIDANCE is not a human answer or execution permission. Follow its principle sources and authority limits.",
			"If you need answers to multiple questions, make multiple separate ask_user_question tool calls instead of combining them into one prompt.",
			'Users will always be able to select "Other" to provide custom text input when options are provided.',
			"Use multiSelect: true only when you need multiple answers to the same question.",
			'If you recommend a specific option, make it the first option in the list and add "(Recommended)" at the end of the label.',
			"Prefer this tool over guessing when requirements, preferences, or implementation choices are unclear.",
			"Use this tool when multiple valid implementation paths exist and the preferred path depends on user choice.",
		],
		parameters: AskUserQuestionParams,

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			return executeQuestion(pi, params, signal, ctx, undefined, () => {
				const current = currentApproval(ctx);
				const text = guidanceForQuestion(current, ctx.sessionManager.getSessionId(), params.policy, params.secure === true);
				return text && current ? { text, approvalId: current.approvalId } : undefined;
			});
		},

		renderCall(args, theme) {
			const options = normalizeOptions(args.options as Array<{ label: string; value?: string; description?: string }> | undefined);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question ")) + theme.fg("muted", args.question);
			if (args.multiSelect) {
				text += theme.fg("dim", " [multi-select]");
			}
			if (options.length > 0) {
				const other = buildChoiceItems(options).at(-1)!;
				const labels = [...options.map((option) => option.label), other.label].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}

			if (details.status === "policy-guidance") {
				return new Text(theme.fg("accent", details.message || "AUTOMATIC POLICY GUIDANCE"), 0, 0);
			}

			if (details.status === "cancelled") {
				return new Text(theme.fg("warning", details.message || "Cancelled"), 0, 0);
			}

			if (details.status === "invalid" || details.status === "unavailable") {
				return new Text(theme.fg("warning", details.message || "ask_user_question unavailable"), 0, 0);
			}

			const lines = details.answers.map((answer) => {
				switch (answer.type) {
					case "text":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.label || "(empty response)")}`;
					case "other":
						return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${theme.fg("accent", answer.label)}`;
					case "option":
						return `${theme.fg("success", "✓ ")}${theme.fg("accent", `${answer.index}. ${answer.label}`)}`;
				}
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
