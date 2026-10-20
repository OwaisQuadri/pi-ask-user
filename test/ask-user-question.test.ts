import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const tuiModule = `
export const Key = { up: "UP", down: "DOWN", enter: "ENTER", space: "SPACE", backspace: "BACKSPACE", escape: "ESC", ctrl: (key) => "CTRL_" + key };
export const getNativeClipboard = () => globalThis.__askClipboard;
export const matchesKey = (data, key) => data === key;
export const truncateToWidth = (text) => text;
export const wrapTextWithAnsi = (text) => [text];
export class Text { constructor(text) { this.text = text; } }
export class Editor {
	constructor() { this.text = ""; this.onSubmit = undefined; }
	setText(text) { this.text = text; }
	getText() { return this.text; }
	insertTextAtCursor(text) { this.text += text; globalThis.__askLastInsertion = text; }
	handleInput(data) {
		if (data === "ENTER") { this.onSubmit?.(this.text); return; }
		if (data === "SHIFT_ENTER") { this.text += "\\n"; return; }
		if (data === "BACKSPACE") { this.text = this.text.slice(0, -1); return; }
		this.text += data;
	}
	render() { return []; }
}
`;

const typeboxModule = `
export const Type = {
	Object: (value) => value,
	String: (value) => value,
	Optional: (value) => value,
	Array: (value) => value,
	Boolean: (value) => value,
};
`;

async function writeModule(root: string, name: string, source: string): Promise<void> {
	const directory = join(root, "node_modules", ...name.split("/"));
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, "package.json"), '{"type":"module","exports":"./index.js"}');
	await writeFile(join(directory, "index.js"), source);
}

async function loadPicker(mode = "rpc") {
	const root = await mkdtemp(join(tmpdir(), "ask-user-question-"));
	await writeFile(join(root, "ask-user-question.ts"), await readFile(extensionPath));
	await writeModule(root, "@earendil-works/pi-tui", tuiModule);
	await writeModule(root, "typebox", typeboxModule);
	await writeModule(root, "@earendil-works/pi-coding-agent", "");

	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const lifecycleHandlers = new Map<string, (event: unknown, context: unknown) => void>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	let tool: any;
	let component: any;
	let customCallCount = 0;
	const editorCalls: Array<{ title: string; prefill: string | undefined }> = [];
	let resolveEditor: ((value: string | undefined) => void) | undefined;
	const notices: string[] = [];
	const theme = {
		fg(_name: string, text: string) {
			return text;
		},
		bold(text: string) {
			return text;
		},
	};
	const ctx = {
		hasUI: true,
		mode,
		sessionManager: { getSessionId: () => "session-1" },
		ui: {
			notify(message: string) {
				notices.push(message);
			},
			custom(factory: any) {
				customCallCount++;
				return new Promise((resolve) => {
					component = factory({ requestRender() {} }, theme, {}, resolve);
				});
			},
			editor(title: string, prefill?: string) {
				editorCalls.push({ title, prefill });
				return new Promise<string | undefined>((resolve) => {
					resolveEditor = resolve;
				});
			},
		},
	};
	const api = {
		registerTool(value: unknown) {
			tool = value;
		},
		on(event: string, handler: (event: unknown, context: unknown) => void) {
			lifecycleHandlers.set(event, handler);
		},
		events: {
			on(channel: string, handler: (payload: unknown) => void) {
				const handlers = eventHandlers.get(channel) ?? [];
				eventHandlers.set(channel, [...handlers, handler]);
				return () => eventHandlers.set(channel, (eventHandlers.get(channel) ?? []).filter((item) => item !== handler));
			},
			emit(channel: string, payload: unknown) {
				emitted.push({ channel, payload });
				for (const handler of eventHandlers.get(channel) ?? []) handler(payload);
			},
		},
	};
	const module = await import(`${pathToFileURL(join(root, "ask-user-question.ts")).href}?${Date.now()}-${Math.random()}`);
	module.default(api);
	lifecycleHandlers.get("session_start")?.({}, ctx);
	return {
		tool,
		ctx,
		api,
		emitted,
		lifecycleHandlers,
		notices,
		component: () => component,
		customCallCount: () => customCallCount,
		editorCalls,
		resolveEditor: (value: string | undefined) => resolveEditor?.(value),
		dispose: async () => {
			await rm(root, { recursive: true, force: true });
		},
	};
}

function createTrackedAbortSignal() {
	let isAborted = false;
	const listeners = new Set<() => void>();
	return {
		signal: {
			get aborted() {
				return isAborted;
			},
			addEventListener(_type: string, listener: () => void) {
				listeners.add(listener);
			},
			removeEventListener(_type: string, listener: () => void) {
				listeners.delete(listener);
			},
		} as AbortSignal,
		abort() {
			isAborted = true;
			for (const listener of listeners) listener();
		},
		listenerCount() {
			return listeners.size;
		},
	};
}

async function waitForComponent(getComponent: () => any): Promise<any> {
	for (let attempt = 0; attempt < 20; attempt++) {
		const component = getComponent();
		if (component !== undefined) {
			return component;
		}
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error("picker did not open");
}

test("Ctrl+V pastes clipboard text into the free-text answer", async () => {
	const picker = await loadPicker("tui");
	(globalThis as any).__askClipboard = {
		getImage: async () => null,
		getText: async () => "pasted text",
	};
	try {
		const pending = picker.tool.execute("paste-text", { question: "What?" }, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		component.handleInput("CTRL_v");
		await new Promise((resolve) => setTimeout(resolve, 0));
		component.handleInput("ENTER");
		assert.equal((await pending).details.answers[0].value, "pasted text");
	} finally {
		delete (globalThis as any).__askClipboard;
		await picker.dispose();
	}
});

test("Ctrl+V pastes an image path into a multi-select Other answer", async () => {
	const picker = await loadPicker("tui");
	const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
	delete (globalThis as any).__askLastInsertion;
	(globalThis as any).__askClipboard = { getImage: async () => bytes, getText: async () => "unused" };
	let imagePath: string | undefined;
	try {
		const pending = picker.tool.execute("paste-image", {
			question: "Choose", options: [{ label: "First" }, { label: "Second" }], multiSelect: true,
		}, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		component.handleInput("DOWN");
		component.handleInput("DOWN");
		component.handleInput("ENTER");
		component.handleInput("CTRL_v");
		for (let attempt = 0; attempt < 50 && !(globalThis as any).__askLastInsertion; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
		assert.match((globalThis as any).__askLastInsertion, /pi-clipboard-.*\.png$/);
		component.handleInput("ENTER");
		component.handleInput("DOWN");
		component.handleInput("ENTER");
		const settled = await pending;
		imagePath = settled.details.answers[0].value;
		assert.match(imagePath!, /pi-clipboard-.*\.png$/);
		assert.deepEqual(await readFile(imagePath!), bytes);
	} finally {
		delete (globalThis as any).__askClipboard;
		delete (globalThis as any).__askLastInsertion;
		if (imagePath) await rm(imagePath, { force: true });
		await picker.dispose();
	}
});

test("Ctrl+V pastes text into a single-select Other answer", async () => {
	const picker = await loadPicker("tui");
	(globalThis as any).__askClipboard = { getImage: async () => null, getText: async () => "custom answer" };
	try {
		const pending = picker.tool.execute("paste-other", {
			question: "Choose", options: [{ label: "First" }, { label: "Second" }],
		}, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		component.handleInput("DOWN");
		component.handleInput("DOWN");
		component.handleInput("ENTER");
		component.handleInput("CTRL_v");
		await new Promise((resolve) => setTimeout(resolve, 0));
		component.handleInput("ENTER");
		assert.equal((await pending).details.answers[0].value, "custom answer");
	} finally {
		delete (globalThis as any).__askClipboard;
		await picker.dispose();
	}
});

test("a cancelled question ignores a late clipboard read", async () => {
	const picker = await loadPicker("tui");
	let resolveImage: ((value: Uint8Array | null) => void) | undefined;
	(globalThis as any).__askClipboard = {
		getImage: () => new Promise((resolve) => { resolveImage = resolve; }),
		getText: async () => "late paste",
	};
	try {
		const pending = picker.tool.execute("late-paste", { question: "What?" }, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		component.handleInput("CTRL_v");
		component.handleInput("ESC");
		resolveImage?.(null);
		assert.equal((await pending).details.status, "cancelled");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.notEqual((globalThis as any).__askLastInsertion, "late paste");
	} finally {
		delete (globalThis as any).__askClipboard;
		await picker.dispose();
	}
});

test("submits multiline free-text questions and rejects a supplied single option", async () => {
	const picker = await loadPicker("tui");
	try {
		const textResult = picker.tool.execute("text", { question: "What?", options: [] }, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		component.handleInput("first line");
		component.handleInput("SHIFT_ENTER");
		component.handleInput("second line");
		component.handleInput("ENTER");
		const settled = await textResult;
		assert.equal(settled.details.mode, "text");
		assert.equal(settled.details.answers[0].value, "first line\nsecond line");

		const invalid = await picker.tool.execute(
			"invalid",
			{ question: "Choose", options: [{ label: "Only" }] },
			undefined,
			undefined,
			picker.ctx,
		);
		assert.equal(invalid.details.status, "invalid");
		assert.match(invalid.content[0].text, /at least two non-blank options/);
	} finally {
		await picker.dispose();
	}
});

test("uses the supported editor for direct RPC free-text questions", async () => {
	const picker = await loadPicker("rpc");
	try {
		const result = picker.tool.execute("rpc-text", { question: "What?", details: "Add context" }, undefined, undefined, picker.ctx);
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(picker.editorCalls.length, 1);
		assert.equal(picker.editorCalls[0]?.title, "What?\n\nAdd context");
		assert.equal(picker.editorCalls[0]?.prefill, "");
		assert.equal(picker.customCallCount(), 0);
		picker.resolveEditor("first line\nsecond line");
		const settled = await result;
		assert.equal(settled.details.answers[0].value, "first line\nsecond line");
	} finally {
		await picker.dispose();
	}
});

test("keeps single-select option answers", async () => {
	const picker = await loadPicker("tui");
	try {
		const result = picker.tool.execute(
			"single",
			{ question: "Choose", options: [{ label: "First" }, { label: "Second" }] },
			undefined,
			undefined,
			picker.ctx,
		);
		const component = await waitForComponent(picker.component);
		component.handleInput("ENTER");
		const settled = await result;
		assert.deepEqual(settled.details.answers, [{ type: "option", label: "First", value: "First", index: 1 }]);
	} finally {
		await picker.dispose();
	}
});

test("an answered question keeps its result without writing core memory", async () => {
	const picker = await loadPicker("tui");
	try {
		const result = picker.tool.execute(
			"capture",
			{ question: "Which shell?", options: [{ label: "zsh" }, { label: "bash" }] },
			undefined,
			undefined,
			picker.ctx,
		);
		const component = await waitForComponent(picker.component);
		component.handleInput("ENTER");
		const settled = await result;
		assert.equal(settled.content[0].text, "User selected: 1. zsh");
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.deepEqual(picker.notices, []);
	} finally {
		await picker.dispose();
	}
});

test("selects the final item from an unbounded option list", async () => {
	const picker = await loadPicker("tui");
	try {
		const result = picker.tool.execute(
			"many",
			{
				question: "Choose",
				multiSelect: true,
				options: Array.from({ length: 100 }, (_, index) => ({ label: `Option ${index + 1}` })),
			},
			undefined,
			undefined,
			picker.ctx,
		);
		const component = await waitForComponent(picker.component);
		for (let index = 0; index < 99; index++) {
			component.handleInput("DOWN");
		}
		component.handleInput("SPACE");
		component.handleInput("DOWN");
		component.handleInput("DOWN");
		component.handleInput("ENTER");

		const settled = await result;
		assert.deepEqual(settled.details.answers, [{ type: "option", label: "Option 100", value: "Option 100", index: 100 }]);
	} finally {
		await picker.dispose();
	}
});

test("edits and removes an individual Other answer", async () => {
	const picker = await loadPicker("tui");
	try {
		const result = picker.tool.execute(
			"other",
			{ question: "Choose", multiSelect: true, options: [{ label: "One" }, { label: "Two" }] },
			undefined,
			undefined,
			picker.ctx,
		);
		const component = await waitForComponent(picker.component);
		component.handleInput("DOWN");
		component.handleInput("DOWN");
		component.handleInput("ENTER");
		component.handleInput("First answer");
		component.handleInput("ENTER");
		component.handleInput("ENTER");
		component.handleInput("Second answer");
		component.handleInput("ENTER");
		component.handleInput("UP");
		component.handleInput("ENTER");
		for (let index = 0; index < "Second answer".length; index++) {
			component.handleInput("BACKSPACE");
		}
		component.handleInput("Updated second answer");
		component.handleInput("ENTER");

		let lines = component.render(120).join("\n");
		assert.match(lines, /> \[x\] Other: Updated second answer/);
		assert.match(lines, /\[x\] Other: First answer/);

		component.handleInput("SPACE");
		lines = component.render(120).join("\n");
		assert.doesNotMatch(lines, /Updated second answer/);
		assert.match(lines, /\[x\] Other: First answer/);

		component.handleInput("DOWN");
		component.handleInput("ENTER");
		const settled = await result;
		assert.deepEqual(settled.details.answers, [
			{ type: "other", label: "First answer", value: "First answer" },
		]);
	} finally {
		await picker.dispose();
	}
});

test("adds a second Other answer from the final Add Other row", async () => {
	const picker = await loadPicker("tui");
	try {
		const result = picker.tool.execute(
			"other",
			{ question: "Choose", multiSelect: true, options: [{ label: "One" }, { label: "Two" }] },
			undefined,
			undefined,
			picker.ctx,
		);
		const component = await waitForComponent(picker.component);
		component.handleInput("DOWN");
		component.handleInput("DOWN");
		component.handleInput("ENTER");
		component.handleInput("First answer");
		component.handleInput("ENTER");
		component.handleInput("ENTER");
		component.handleInput("Second answer");
		component.handleInput("ENTER");
		component.handleInput("ENTER");
		component.handleInput("first answer");
		component.handleInput("ENTER");

		const lines = component.render(120).join("\n");
		assert.equal((lines.match(/\[ \] Add Other/g) ?? []).length, 1);
		assert.match(lines, /\[x\] Other: First answer/);
		assert.match(lines, /\[x\] Other: Second answer/);
		assert.doesNotMatch(lines, /custom answers/);

		component.handleInput("DOWN");
		component.handleInput("ENTER");
		const settled = await result;
		assert.deepEqual(settled.details.answers, [
			{ type: "other", label: "First answer", value: "First answer" },
			{ type: "other", label: "Second answer", value: "Second answer" },
		]);
	} finally {
		await picker.dispose();
	}
});

test("reports Herdr blocked until picker cancellation", async () => {
	const picker = await loadPicker("tui");
	try {
		const result = picker.tool.execute(
			"cancel",
			{ question: "Choose", options: [{ label: "One" }, { label: "Two" }] },
			undefined,
			undefined,
			picker.ctx,
		);
		const component = await waitForComponent(picker.component);
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), [
			{ channel: "herdr:blocked", payload: { active: true, label: "Choose" } },
		]);
		component.handleInput("ESC");
		const settled = await result;
		assert.equal(settled.details.status, "cancelled");
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), [
			{ channel: "herdr:blocked", payload: { active: true, label: "Choose" } },
			{ channel: "herdr:blocked", payload: { active: false } },
		]);
	} finally {
		await picker.dispose();
	}
});

test("bounds RPC requests after the interactive session shuts down", async () => {
	const picker = await loadPicker("tui");
	try {
		picker.lifecycleHandlers.get("session_shutdown")?.({}, { ...picker.ctx });
		const pingReplies: unknown[] = [];
		picker.api.events.on("ask-user-question:rpc:ping:reply:ping-0", (payload: unknown) => pingReplies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ping", { requestId: "ping-0" });
		assert.deepEqual(pingReplies, [{ success: false, error: "No active interactive session" }]);

		const askReplies: any[] = [];
		picker.api.events.on("ask-user-question:rpc:ask:reply:ask-0", (payload: unknown) => askReplies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "ask-0", params: { question: "What?" } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(askReplies[0]?.success, false);
		assert.match(askReplies[0]?.error, /No active interactive session/);
	} finally {
		await picker.dispose();
	}
});

test("does not let child extension instances answer root RPC pings", async () => {
	const picker = await loadPicker("rpc");
	try {
		const pingReplies: unknown[] = [];
		picker.api.events.on("ask-user-question:rpc:ping:reply:child-ping", (payload: unknown) => pingReplies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ping", { requestId: "child-ping" });
		assert.deepEqual(pingReplies, []);
	} finally {
		await picker.dispose();
	}
});

test("rejects malformed RPC question parameters", async () => {
	const picker = await loadPicker("tui");
	try {
		const replies: any[] = [];
		picker.api.events.on("ask-user-question:rpc:ask:reply:bad-1", (payload: unknown) => replies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "bad-1", params: { question: "  " } });
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(replies[0]?.success, false);
		assert.match(replies[0]?.error, /Invalid ask_user_question parameters/);
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), []);
	} finally {
		await picker.dispose();
	}
});

test("rejects an RPC request with a non-AbortSignal signal", async () => {
	const picker = await loadPicker("tui");
	try {
		const replies: any[] = [];
		picker.api.events.on("ask-user-question:rpc:ask:reply:bad-signal", (payload: unknown) => replies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ask", {
			requestId: "bad-signal",
			params: { question: "What?" },
			signal: {},
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.equal(replies[0]?.success, false);
		assert.match(replies[0]?.error, /Invalid ask_user_question abort signal/);
	} finally {
		await picker.dispose();
	}
});

test("aborts custom dialogs and balances Herdr blocked", async () => {
	for (const params of [
		{ question: "What?" },
		{ question: "Choose", options: [{ label: "One" }, { label: "Two" }] },
		{ question: "Choose", multiSelect: true, options: [{ label: "One" }, { label: "Two" }] },
	]) {
		const picker = await loadPicker("tui");
		try {
			const controller = createTrackedAbortSignal();
			const result = picker.tool.execute(
				"abort-picker",
				params,
				controller.signal,
				undefined,
				picker.ctx,
			);
			await waitForComponent(picker.component);
			controller.abort();
			const settled = await result;
			assert.equal(controller.listenerCount(), 0);
			assert.equal(settled.details.status, "cancelled");
			assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), [
				{ channel: "herdr:blocked", payload: { active: true, label: params.question } },
				{ channel: "herdr:blocked", payload: { active: false } },
			]);
		} finally {
			await picker.dispose();
		}
	}
});

test("disposing choice pickers cancels, removes listeners, and releases the shared UI lock", async () => {
	for (const params of [
		{ question: "Choose", options: [{ label: "One" }, { label: "Two" }] },
		{ question: "Choose", multiSelect: true, options: [{ label: "One" }, { label: "Two" }] },
	]) {
		const picker = await loadPicker("tui");
		try {
			const controller = createTrackedAbortSignal();
			const result = picker.tool.execute("dispose-picker", params, controller.signal, undefined, picker.ctx);
			const component = await waitForComponent(picker.component);
			component.dispose();
			const settled = await result;
			assert.equal(controller.listenerCount(), 0);
			assert.equal(settled.details.status, "cancelled");

			const nextResult = picker.tool.execute("next-picker", params, undefined, undefined, picker.ctx);
			let nextComponent: any;
			for (let attempt = 0; attempt < 20; attempt++) {
				nextComponent = picker.component();
				if (nextComponent !== component) break;
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			assert.notEqual(nextComponent, component);
			nextComponent.handleInput("ESC");
			await nextResult;
			assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), [
				{ channel: "herdr:blocked", payload: { active: true, label: "Choose" } },
				{ channel: "herdr:blocked", payload: { active: false } },
				{ channel: "herdr:blocked", payload: { active: true, label: "Choose" } },
				{ channel: "herdr:blocked", payload: { active: false } },
			]);
		} finally {
			await picker.dispose();
		}
	}
});

test("does not emit blocked when the tool cannot open a question", async () => {
	const picker = await loadPicker();
	try {
		picker.ctx.hasUI = false;
		const unavailable = await picker.tool.execute("headless", { question: "What?" }, undefined, undefined, picker.ctx);
		assert.equal(unavailable.details.status, "unavailable");
		const controller = new AbortController();
		controller.abort();
		picker.ctx.hasUI = true;
		const cancelled = await picker.tool.execute("aborted", { question: "What?" }, controller.signal, undefined, picker.ctx);
		assert.equal(cancelled.details.status, "cancelled");
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), []);
	} finally {
		await picker.dispose();
	}
});

test("serializes concurrent RPC prompts and balances each Herdr span", async () => {
	const picker = await loadPicker("tui");
	try {
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "ask-a", params: { question: "First?" } });
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "ask-b", params: { question: "Second?" } });
		const firstComponent = await waitForComponent(picker.component);
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), [
			{ channel: "herdr:blocked", payload: { active: true, label: "First?" } },
		]);

		firstComponent.handleInput("first");
		firstComponent.handleInput("ENTER");
		let secondComponent: any;
		for (let attempt = 0; attempt < 20; attempt++) {
			secondComponent = picker.component();
			if (secondComponent !== firstComponent) break;
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.notEqual(secondComponent, firstComponent);
		secondComponent.handleInput("second");
		secondComponent.handleInput("ENTER");
		await new Promise((resolve) => setTimeout(resolve, 0));
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "herdr:blocked"), [
			{ channel: "herdr:blocked", payload: { active: true, label: "First?" } },
			{ channel: "herdr:blocked", payload: { active: false } },
			{ channel: "herdr:blocked", payload: { active: true, label: "Second?" } },
			{ channel: "herdr:blocked", payload: { active: false } },
		]);
	} finally {
		await picker.dispose();
	}
});

test("does not open a queued RPC prompt after the root session shuts down", async () => {
	const picker = await loadPicker("tui");
	try {
		const replies: any[] = [];
		picker.api.events.on("ask-user-question:rpc:ask:reply:queued", (payload: unknown) => replies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "first", params: { question: "First?" } });
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "queued", params: { question: "Queued?" } });
		const firstComponent = await waitForComponent(picker.component);

		picker.lifecycleHandlers.get("session_shutdown")?.({}, { ...picker.ctx });
		firstComponent.handleInput("first answer");
		firstComponent.handleInput("ENTER");
		for (let attempt = 0; attempt < 20 && replies.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}

		assert.equal(replies[0]?.success, true);
		assert.equal(replies[0]?.data.details.status, "unavailable");
		assert.equal(picker.customCallCount(), 1);
		assert.equal(picker.component(), firstComponent);
	} finally {
		await picker.dispose();
	}
});

test("question arbitration announces pending work and releases it after cancellation", async () => {
	const picker = await loadPicker("tui");
	try {
		const pending = picker.tool.execute("question-lock", { question: "What?" }, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		assert.equal((globalThis as any).__piSharedUiLock.questionCount, 1);
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "ask-user-question:activity"), [{ channel: "ask-user-question:activity", payload: { isPending: true } }]);
		component.handleInput("ESC");
		await pending;
		assert.equal((globalThis as any).__piSharedUiLock.questionCount, 0);
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "ask-user-question:activity").at(-1), { channel: "ask-user-question:activity", payload: { isPending: false } });
	} finally {
		await picker.dispose();
	}
});

test("serves the same question result over the in-process RPC", async () => {
	const picker = await loadPicker("tui");
	try {
		const pingReplies: unknown[] = [];
		picker.api.events.on("ask-user-question:rpc:ping:reply:ping-1", (payload: unknown) => pingReplies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ping", { requestId: "ping-1" });
		assert.deepEqual(pingReplies, [{ success: true, data: { version: 1 } }]);

		const replies: unknown[] = [];
		picker.api.events.on("ask-user-question:rpc:ask:reply:ask-1", (payload: unknown) => replies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ask", {
			requestId: "ask-1",
			params: { question: "What?" },
		});
		const component = await waitForComponent(picker.component);
		component.handleInput("free text");
		component.handleInput("ENTER");
		for (let attempt = 0; attempt < 20 && replies.length === 0; attempt++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		assert.equal((replies[0] as any).success, true);
		assert.equal((replies[0] as any).data.details.answers[0].value, "free text");
	} finally {
		await picker.dispose();
	}
});

test("a secure question returns a handle, never the value, and redacts the value from later tool results", async () => {
	const picker = await loadPicker("tui");
	try {
		const pending = picker.tool.execute("secret", { question: "OpenRouter key?", secure: true }, undefined, undefined, picker.ctx);
		const component = await waitForComponent(picker.component);
		component.handleInput("sk-or-v1-0123456789abcdef");
		component.handleInput("CTRL_t");
		assert.ok(component.render(80).some((line: string) => line.includes("•".repeat(25))));
		component.handleInput("ENTER");
		const settled = await pending;
		const serialized = JSON.stringify(settled);
		assert.ok(!serialized.includes("sk-or-v1-0123456789abcdef"));
		const handle = settled.details.answers[0].value;
		assert.match(handle, /^\{\{secret:[0-9a-f]{8}\}\}$/);
		assert.deepEqual(picker.emitted.find((event) => event.channel === "ask-user-question:secret")?.payload, { handle, value: "sk-or-v1-0123456789abcdef" });
		const toolResult = picker.lifecycleHandlers.get("tool_result") as any;
		const redacted = toolResult({
			content: [{ type: "text", text: "echo sk-or-v1-0123456789abcdef" }],
			structuredContent: { output: "sk-or-v1-0123456789abcdef\\" },
			details: { stdout: "sk-or-v1-0123456789abcdef" },
		});
		assert.equal(redacted.content[0].text, `echo ${handle}`);
		assert.deepEqual(redacted.structuredContent, { output: `${handle}\\` });
		assert.deepEqual(redacted.details, { stdout: handle });
		assert.equal(toolResult({ content: [{ type: "text", text: "clean" }], structuredContent: { ok: true } }), undefined);
		const context = (picker.lifecycleHandlers.get("context") as any)({ messages: [{ role: "user", content: "key sk-or-v1-0123456789abcdef" }] });
		assert.deepEqual(context.messages, [{ role: "user", content: `key ${handle}` }]);
		const invalid = await picker.tool.execute("secret-options", { question: "Key?", secure: true, options: [{ label: "A" }, { label: "B" }] }, undefined, undefined, picker.ctx);
		assert.equal(invalid.details.status, "invalid");
	} finally {
		await picker.dispose();
	}
});
