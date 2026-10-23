import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const extensionPath = fileURLToPath(new URL("../src/index.ts", import.meta.url));

const tuiModule = `
export const Key = { up: "UP", down: "DOWN", enter: "ENTER", space: "SPACE", backspace: "BACKSPACE", escape: "ESC", pageUp: "PAGE_UP", pageDown: "PAGE_DOWN", ctrl: (key) => "CTRL_" + key };
export const getNativeClipboard = () => globalThis.__askClipboard;
export const matchesKey = (data, key) => data === key;
export const truncateToWidth = (text) => text;
export const wrapTextWithAnsi = (text) => [text];
export class Text { constructor(text) { this.text = text; } render() { return this.text.split("\\n"); } invalidate() {} }
export class ScrollView {
	constructor(child) { this.child = child; this.scrollTop = 0; this.max = 0; }
	render(width) { return this.child.render(width); }
	updateLayout(total, height) { this.max = Math.max(0, total - height); this.scrollTop = Math.min(this.scrollTop, this.max); }
	scrollBy(lines) { this.scrollTop = Math.max(0, Math.min(this.max, this.scrollTop + lines)); }
	invalidate() {}
}
export class SelectList {
	constructor(items) { this.items = items; this.index = 0; }
	render() { return this.items.map((item, index) => (index === this.index ? "→ " : "  ") + item.label); }
	handleInput(key) {
		if (key === "DOWN") this.index = (this.index + 1) % this.items.length;
		if (key === "UP") this.index = (this.index + this.items.length - 1) % this.items.length;
		if (key === "ENTER") this.onSelect?.(this.items[this.index]);
		if (key === "ESC") this.onCancel?.();
	}
	invalidate() {}
}
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
	Union: (value) => value,
	Literal: (value) => value,
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
	await writeFile(join(root, "autonomous.ts"), await readFile(new URL("../src/autonomous.ts", import.meta.url)));
	await writeFile(join(root, "approval.ts"), await readFile(new URL("../src/approval.ts", import.meta.url)));
	await writeModule(root, "@earendil-works/pi-tui", tuiModule);
	await writeModule(root, "typebox", typeboxModule);
	await writeModule(root, "@earendil-works/pi-coding-agent", "");

	const eventHandlers = new Map<string, Array<(payload: unknown) => void>>();
	const lifecycleHandlers = new Map<string, (event: unknown, context: unknown) => void>();
	const emitted: Array<{ channel: string; payload: unknown }> = [];
	let tool: any;
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	let component: any;
	let customCallCount = 0;
	const editorCalls: Array<{ title: string; prefill: string | undefined }> = [];
	let resolveEditor: ((value: string | undefined) => void) | undefined;
	const confirmCalls: Array<{ title: string; message: string }> = [];
	let resolveConfirm: ((isApproved: boolean) => void) | undefined;
	const notices: string[] = [];
	const statuses = new Map<string, string | undefined>();
	const selections: Array<{ title: string; options: string[] }> = [];
	let resolveSelection: ((choice: string | undefined) => void) | undefined;
	const sentMessages: any[] = [];
	const credentialCatalog = { credentials: [] as Array<{ name: string; isGranted: boolean }> };
	const branch: any[] = [];
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
		cwd: root,
		signal: undefined as AbortSignal | undefined,
		hasPendingMessages: () => false,
		isIdle: () => true,
		tools: [{ name: "cred_list" }],
		executeTool: async () => ({ result: { details: credentialCatalog }, isError: false }),
		sessionManager: { getSessionId: () => "session-1", getBranch: () => branch },
		ui: {
			setStatus(key: string, value: string | undefined) { statuses.set(key, value); },
			select(title: string, options: string[]) {
				selections.push({ title, options });
				return new Promise<string | undefined>((resolve) => { resolveSelection = resolve; });
			},
			confirm(title: string, message: string) {
				confirmCalls.push({ title, message });
				return new Promise<boolean>((resolve) => { resolveConfirm = resolve; });
			},
			notify(message: string) {
				notices.push(message);
			},
			custom(factory: any) {
				customCallCount++;
				return new Promise((resolve) => {
					component = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, {}, resolve);
					if (component.render(80)[0] === "Approve autonomous work") {
						const pages: string[] = [];
						for (let page = 0; page < 8; page++) {
							const lines = component.render(80);
							assert.ok(lines.length <= 17);
							assert.match(lines.join("\n"), /Approve and start/);
							pages.push(lines.join("\n"));
							component.handleInput("PAGE_DOWN");
						}
						for (let page = 0; page < 8; page++) component.handleInput("PAGE_UP");
						selections.push({ title: pages.join("\n"), options: ["Cancel", "Edit scope", "Approve and start"] });
						resolveSelection = (choice) => {
							if (choice === undefined) { component.handleInput("ESC"); return; }
							for (let index = 0; index < ["Cancel", "Edit scope", "Approve and start"].indexOf(choice); index++) component.handleInput("DOWN");
							component.handleInput("ENTER");
						};
					}
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
		sendMessage: (message: any, options: any) => sentMessages.push({ message, options }),
		getAllTools: () => [...tools.values()],
		appendEntry: (customType: string, data: unknown) => branch.push({ type: "custom", customType, data }),
		registerTool(value: any) {
			tools.set(value.name, value);
			if (value.name === "ask_user_question") tool = value;
		},
		registerCommand(name: string, value: any) {
			commands.set(name, value);
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
		tools,
		commands,
		confirmCalls,
		statuses, selections, sentMessages, credentialCatalog,
		resolveSelection: (choice: string | undefined) => resolveSelection?.(choice),
		resolveConfirm: (isApproved: boolean) => resolveConfirm?.(isApproved),
		ctx,
		api,
		emitted,
		lifecycleHandlers,
		branch,
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

function autonomousScope() {
	return {
		taskId: "picker-task", scope: "Update the picker", protectedActions: [],
		principleSources: ["ask-user-question.ts"], expiresAt: new Date(Date.now() + 60_000).toISOString(),
		preparation: { decisions: ["Update the picker only"], credentials: [] as string[], accessChecks: ["No external access required"] },
	};
}

async function prepareMode(picker: Awaited<ReturnType<typeof loadPicker>>) {
	await picker.tools.get("autonomous_mode").execute("prepare", { action: "prepare" }, undefined, undefined, picker.ctx);
	const previous = picker.component();
	const pending = picker.tool.execute("grill", { question: "What outcome and limits should this task have?" }, undefined, undefined, picker.ctx);
	const component = await waitForComponent(() => picker.component() !== previous ? picker.component() : undefined);
	component.handleInput("Update the picker only; no external access.");
	component.handleInput("ENTER");
	assert.equal((await pending).details.provenance, "interactive-user");
}

async function approveMode(picker: Awaited<ReturnType<typeof loadPicker>>, scope = autonomousScope()) {
	await prepareMode(picker);
	const count = picker.selections.length;
	const pending = picker.tools.get("autonomous_mode").execute("enable", { action: "on", scope }, undefined, undefined, picker.ctx);
	await waitForComponent(() => picker.selections.length > count ? true : undefined);
	assert.match(picker.selections.at(-1)!.title, /not execution authorization/);
	picker.resolveSelection("Approve and start");
	return pending;
}

test("autonomous enablement and widening require human confirmation, not proposed approval text", async () => {
	const picker = await loadPicker("tui");
	try {
		const scope = autonomousScope();
		const mode = picker.tools.get("autonomous_mode");
		const unprepared = await mode.execute("enable", { action: "on", scope: { ...scope, isApproved: true } }, undefined, undefined, picker.ctx);
		assert.equal(unprepared.details.isActive, false);
		assert.equal(unprepared.details.isPreparing, true);
		assert.equal(picker.selections.length, 0);
		await prepareMode(picker);
		const pending = mode.execute("enable", { action: "on", scope }, undefined, undefined, picker.ctx);
		await waitForComponent(() => picker.selections[0]);
		assert.deepEqual(picker.selections[0].options, ["Cancel", "Edit scope", "Approve and start"]);
		picker.resolveSelection("Cancel");
		assert.equal((await pending).details.isActive, false);
		assert.equal(picker.editorCalls.length, 0);
		const approved = await approveMode(picker, scope);
		assert.equal(approved.details.approval.provenance, "interactive-user");
		assert.equal(approved.details.approval.expiresOn, "task_complete");
		const wider = { ...scope, scope: "Update everything" };
		const widening = await mode.execute("widen", { action: "on", scope: wider }, undefined, undefined, picker.ctx);
		assert.equal(widening.details.isActive, true);
		assert.equal(widening.details.isPreparing, false);
		assert.equal(widening.details.approval.approvalId, approved.details.approval.approvalId);
		for (const action of ["off", "prepare"]) {
			const refused = await mode.execute("refused", { action }, undefined, undefined, picker.ctx);
			assert.equal(refused.details.approval.approvalId, approved.details.approval.approvalId);
		}
		assert.match(picker.statuses.get("autonomous")!, /Running/);
	} finally { await picker.dispose(); }
});

test("autonomous guidance is AI labeled while secure and essential-information questions remain human", async () => {
	const picker = await loadPicker("tui");
	try {
		const scope = autonomousScope();
		const approved = await approveMode(picker, scope);
		const policy = { taskId: scope.taskId, scope: scope.scope, kind: "routine", isReversible: true };
		const initialCount = picker.customCallCount();
		const result = await picker.tool.execute("routine", {
			question: "Choose an implementation?", policy, options: [{ label: "A" }, { label: "B" }],
		}, undefined, undefined, picker.ctx);
		assert.equal(result.details.status, "policy-guidance");
		assert.equal(result.details.provenance, "automatic-policy-guidance");
		assert.equal(result.details.approvalId, approved.details.approval.approvalId);
		assert.deepEqual(result.details.answers, []);
		assert.equal(picker.customCallCount(), initialCount);
		assert.match(picker.tool.renderResult(result, {}, { fg: (_name: string, text: string) => text }).text, /AI auto-reply/);
		const missing = await picker.tool.execute("missing", { question: "Unclassified?" }, undefined, undefined, picker.ctx);
		assert.equal(missing.isError, true);
		assert.deepEqual(missing.details.answers, []);
		assert.match(missing.content[0].text, /AI ROUTING ERROR/);
		assert.equal(picker.customCallCount(), initialCount);
		for (const params of [{ question: "Information only you hold?", policy: { ...policy, kind: "information" } }, { question: "Secret?", policy, secure: true }]) {
			const oldComponent = picker.component();
			const pending = picker.tool.execute("interactive", params, undefined, undefined, picker.ctx);
			const component = await waitForComponent(() => picker.component() !== oldComponent ? picker.component() : undefined);
			component.handleInput("human-input-value");
			component.handleInput("ENTER");
			assert.equal((await pending).details.provenance, "interactive-user");
		}
		const oldComponent = picker.component();
		const replies: any[] = [];
		picker.api.events.on("ask-user-question:rpc:ask:reply:child", (payload) => replies.push(payload));
		picker.api.events.emit("ask-user-question:rpc:ask", { requestId: "child", params: { question: "Child?", policy } });
		await waitForComponent(() => replies[0]);
		assert.equal(picker.component(), oldComponent);
		assert.equal(replies[0].data.isError, true);
		assert.equal(replies[0].data.details.provenance, "automatic-policy-guidance");
		assert.equal(replies[0].data.details.approvalId, undefined);
		assert.match(replies[0].data.content[0].text, /supervising agent/);
		for (const params of [
			{ question: "Grant new authority?", policy: { ...policy, kind: "approval" } },
			{ question: "User-held information?", policy: { ...policy, kind: "information" } },
			{ question: "Secret?", secure: true },
		]) {
			const requestId = `human-${replies.length}`;
			const previous = picker.component();
			const humanReplies: any[] = [];
			picker.api.events.on(`ask-user-question:rpc:ask:reply:${requestId}`, (payload) => humanReplies.push(payload));
			picker.api.events.emit("ask-user-question:rpc:ask", { requestId, params });
			const component = await waitForComponent(() => picker.component() !== previous ? picker.component() : undefined);
			component.handleInput("human-input-value");
			component.handleInput("ENTER");
			await waitForComponent(() => humanReplies[0]);
			assert.equal(humanReplies[0].data.details.provenance, "interactive-user");
		}
	} finally { await picker.dispose(); }
});

test("autonomous approval cannot survive task completion, lifecycle changes or pending confirmation revocation", async () => {
	const picker = await loadPicker("tui");
	try {
		const mode = picker.tools.get("autonomous_mode");
		const noTask = await mode.execute("complete-missing", { action: "task_complete" }, undefined, undefined, picker.ctx);
		assert.match(noTask.content[0].text, /requires the active taskId/);
		await approveMode(picker);
		const mismatch = await mode.execute("complete-other", { action: "task_complete", taskId: "other" }, undefined, undefined, picker.ctx);
		assert.equal(mismatch.details.isActive, true);
		const complete = await mode.execute("complete", { action: "task_complete", taskId: "picker-task" }, undefined, undefined, picker.ctx);
		assert.equal(complete.details.isActive, false);
		assert.equal(picker.statuses.get("autonomous"), "Autonomous · Complete");
		for (const event of ["session_before_fork", "session_before_switch", "session_before_tree", "session_shutdown", "session_start"]) {
			picker.lifecycleHandlers.get("session_start")?.({}, picker.ctx);
			await approveMode(picker);
			picker.lifecycleHandlers.get(event)?.({}, picker.ctx);
			assert.equal((await mode.execute("status", { action: "status" }, undefined, undefined, picker.ctx)).details.isActive, false);
		}
		await prepareMode(picker);
		const count = picker.selections.length;
		const pending = mode.execute("late", { action: "on", scope: autonomousScope() }, undefined, undefined, picker.ctx);
		await waitForComponent(() => picker.selections.length > count ? true : undefined);
		await picker.commands.get("autonomous").handler("off", picker.ctx);
		picker.resolveSelection("Approve and start");
		assert.equal((await pending).details.isActive, false);
	} finally { await picker.dispose(); }
});

test("ungranted credentials block start until the credential broker verifies access", async () => {
	const picker = await loadPicker("tui");
	try {
		await prepareMode(picker);
		const mode = picker.tools.get("autonomous_mode");
		const scope = autonomousScope();
		scope.preparation.credentials = ["tracker"];
		picker.credentialCatalog.credentials.push({ name: "tracker", isGranted: false });
		const blocked = await mode.execute("blocked", { action: "on", scope }, undefined, undefined, picker.ctx);
		assert.equal(blocked.details.isActive, false);
		assert.match(blocked.content[0].text, /not verified as granted: tracker/);
		assert.equal(picker.selections.length, 0);
		picker.credentialCatalog.credentials[0].isGranted = true;
		const pending = mode.execute("ready", { action: "on", scope }, undefined, undefined, picker.ctx);
		await waitForComponent(() => picker.selections[0]);
		assert.match(picker.selections[0].title, /Credentials: tracker/);
		picker.resolveSelection("Edit scope");
		assert.equal((await pending).details.isActive, false);
		assert.match(picker.statuses.get("autonomous")!, /Preparing/);
	} finally { await picker.dispose(); }
});

test("autonomous command approval refuses expired scopes and unreadable sources before confirmation", async () => {
	const picker = await loadPicker("tui");
	try {
		const command = picker.commands.get("autonomous");
		await command.handler("on", picker.ctx);
		assert.match(picker.sentMessages[0].message.content, /grill session/);
		assert.equal(picker.sentMessages[0].options.triggerTurn, true);
		await prepareMode(picker);
		const mode = picker.tools.get("autonomous_mode");
		for (const scope of [
			{ ...autonomousScope(), expiresAt: "2000-01-01T00:00:00Z" },
			{ ...autonomousScope(), principleSources: ["missing-owner-file.md"] },
		]) {
			const result = await mode.execute("invalid", { action: "on", scope }, undefined, undefined, picker.ctx);
			assert.equal(result.details.isActive, false);
			assert.equal(picker.selections.length, 0);
		}
		await approveMode(picker);
		await command.handler("status", picker.ctx);
		assert.match(picker.notices.at(-1)!, /Autonomous policy guidance is on/);
		await command.handler("off", picker.ctx);
		assert.equal(picker.notices.at(-1), "Autonomous policy guidance is off.");
	} finally { await picker.dispose(); }
});

test("autonomous commands complete subcommands and child instances cannot enable mode", async () => {
	const picker = await loadPicker("rpc");
	try {
		const command = picker.commands.get("autonomous");
		assert.deepEqual(command.getArgumentCompletions("").map((item: any) => item.value), ["on", "off", "status"]);
		assert.deepEqual(command.getArgumentCompletions("st").map((item: any) => item.value), ["status"]);
		const result = await picker.tools.get("autonomous_mode").execute("child", { action: "on", scope: autonomousScope() }, undefined, undefined, picker.ctx);
		assert.equal(result.details.isActive, false);
		assert.equal(picker.editorCalls.length, 0);
		assert.equal(picker.confirmCalls.length, 0);
	} finally { await picker.dispose(); }
});

function settleEvent() {
	return {
		type: "agent_before_settle", outcome: "completed", continue: false, entries: [] as any[],
		context: { canContinue: false, pendingMessages: [] as any[], contextMessages: [] as any[] },
	};
}

function nativeReply(picker: Awaited<ReturnType<typeof loadPicker>>, request: any, data: unknown) {
	picker.api.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
		version: 1, requestId: request.requestId, method: request.method, success: true, data,
	});
}

function nativePing() {
	return { version: 1, methods: ["ping", "status"], session: { sessionId: "session-1" }, capabilities: { status: true, fleetStatus: { version: 1 } } };
}

function configureNative(picker: Awaited<ReturnType<typeof loadPicker>>, totalActive = 0, omitted = totalActive) {
	picker.tools.set("subagent", { name: "subagent" });
	picker.api.events.on("subagents:rpc:v1:request", (raw) => {
		const request = raw as any;
		nativeReply(picker, request, request.method === "ping" ? nativePing()
			: { fleet: { version: 1, entries: [], totalActive, omitted } });
	});
}

function settle(picker: Awaited<ReturnType<typeof loadPicker>>, event = settleEvent()) {
	return (picker.lifecycleHandlers.get("agent_before_settle") as any)(event, picker.ctx);
}

async function modeStatus(picker: Awaited<ReturnType<typeof loadPicker>>) {
	return picker.tools.get("autonomous_mode").execute("status", { action: "status" }, undefined, undefined, picker.ctx);
}

test("an open autonomous task continues after a final answer until matching task_complete", async () => {
	const picker = await loadPicker("tui");
	try {
		configureNative(picker);
		const approved = await approveMode(picker);
		const event = settleEvent();
		event.entries.push({ type: "custom", customType: "prior-draft", data: {} });
		const result = await settle(picker, event);
		assert.equal(result.continue, true);
		assert.equal(event.context.canContinue, false);
		assert.equal(result.entries[0], event.entries[0]);
		assert.equal(result.entries.length, 2);
		assert.equal(result.entries[1].type, "custom_message");
		assert.equal(result.entries[1].details.approvalId, approved.details.approval.approvalId);
		assert.equal(result.entries[1].details.provenance, "automatic-policy-guidance");
		assert.match(result.entries[1].content, /AUTOMATIC POLICY GUIDANCE/);
		assert.equal((await modeStatus(picker)).details.isActive, true);
		const mode = picker.tools.get("autonomous_mode");
		await mode.execute("mismatch", { action: "task_complete", taskId: "other" }, undefined, undefined, picker.ctx);
		assert.equal((await settle(picker)).continue, true);
		await mode.execute("complete", { action: "task_complete", taskId: "picker-task" }, undefined, undefined, picker.ctx);
		assert.equal(await settle(picker), undefined);
	} finally { await picker.dispose(); }
});

test("exhausted connection retries resume only while autonomous approval remains active", async (t) => {
	const picker = await loadPicker("tui");
	try {
		await approveMode(picker);
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const failed = () => {
			picker.lifecycleHandlers.get("message_end")?.({ message: { role: "assistant", stopReason: "error", errorMessage: "Retry failed after 10 attempts: Connection error." } }, picker.ctx);
			picker.lifecycleHandlers.get("agent_settled")?.({ aborted: false }, picker.ctx);
		};
		failed();
		assert.match(picker.statuses.get("autonomous")!, /Connection retry/);
		t.mock.timers.tick(29_999);
		assert.equal(picker.sentMessages.length, 0);
		t.mock.timers.tick(1);
		assert.equal(picker.sentMessages.length, 1);
		assert.equal(picker.sentMessages[0].message.customType, "autonomous-connection-retry");
		assert.equal(picker.sentMessages[0].options.triggerTurn, true);
		failed();
		t.mock.timers.tick(30_000);
		assert.equal(picker.sentMessages.length, 1);
		await picker.commands.get("autonomous").handler("off", picker.ctx);
		t.mock.timers.tick(300_000);
		assert.equal(picker.sentMessages.length, 1);
		failed();
		t.mock.timers.tick(300_000);
		assert.equal(picker.sentMessages.length, 1);
	} finally { t.mock.timers.reset(); await picker.dispose(); }
});

test("live native jobs including omitted entries permit waiting without another wake owner", async () => {
	const picker = await loadPicker("tui");
	try {
		configureNative(picker, 5, 5);
		await approveMode(picker);
		assert.equal(await settle(picker), undefined);
		assert.equal((await modeStatus(picker)).details.isActive, true);
		assert.deepEqual(picker.emitted.filter(({ channel }) => channel === "subagents:rpc:v1:request").map(({ payload }) => (payload as any).method), ["ping", "status"]);
		assert.equal(picker.emitted.some(({ channel }) => /complete|wake|bg_wait/.test(channel)), false);
	} finally { await picker.dispose(); }
});

test("abort, error, pending input and existing continuation never start another autonomous request", async () => {
	const picker = await loadPicker("tui");
	try {
		await approveMode(picker);
		for (const changes of [{ outcome: "aborted" }, { outcome: "error" }, { continue: true }, { context: { ...settleEvent().context, pendingMessages: [{}] } }]) {
			assert.equal(await settle(picker, { ...settleEvent(), ...changes }), undefined);
		}
		picker.ctx.signal = AbortSignal.abort();
		assert.equal(await settle(picker), undefined);
		assert.equal(picker.emitted.some(({ channel }) => channel === "subagents:rpc:v1:request"), false);
	} finally { await picker.dispose(); }
});

test("asynchronous native reads cannot revive revoked, replaced, expired, aborted or input-owned sessions", async () => {
	for (const change of ["off", "replacement", "switch", "session-id", "expiry", "abort", "pending"] as const) {
		const picker = await loadPicker("tui");
		try {
			const approved = await approveMode(picker);
			const controller = new AbortController();
			picker.ctx.signal = controller.signal;
			let heldRequest: any;
			picker.api.events.on("subagents:rpc:v1:request", (raw) => {
				const request = raw as any;
				if (request.method === "ping") nativeReply(picker, request, nativePing());
				else heldRequest = request;
			});
			const pending = settle(picker);
			await waitForComponent(() => heldRequest);
			if (change === "off") await picker.commands.get("autonomous").handler("off", picker.ctx);
			if (change === "replacement") {
				await picker.commands.get("autonomous").handler("off", picker.ctx);
				await approveMode(picker);
			}
			if (change === "switch") picker.lifecycleHandlers.get("session_before_switch")?.({}, picker.ctx);
			if (change === "session-id") picker.ctx.sessionManager.getSessionId = () => "other-session";
			if (change === "expiry") approved.details.approval.expiresAt = "2000-01-01T00:00:00Z";
			if (change === "abort") controller.abort();
			if (change === "pending") picker.ctx.hasPendingMessages = () => true;
			nativeReply(picker, heldRequest, { fleet: { version: 1, entries: [], totalActive: 0, omitted: 0 } });
			assert.equal(await pending, undefined, change);
			assert.equal(picker.notices.some((notice) => notice.includes("AUTONOMOUS BLOCKER")), false, change);
		} finally { await picker.dispose(); }
	}
});

test("invalid native contracts report blockers without revoking approval or closing the task", async () => {
	for (const fault of ["version", "correlation", "failure", "capability", "session", "fleet", "overflow"] as const) {
		const picker = await loadPicker("tui");
		try {
			await approveMode(picker);
			picker.api.events.on("subagents:rpc:v1:request", (raw) => {
				const request = raw as any;
				if (fault === "version" || fault === "correlation" || fault === "failure") {
					picker.api.events.emit(`subagents:rpc:v1:reply:${request.requestId}`, {
						version: fault === "version" ? 2 : 1, requestId: fault === "correlation" ? "wrong" : request.requestId,
						method: request.method, success: fault !== "failure", data: nativePing(),
					});
				} else if (request.method === "ping") {
					const data = nativePing();
					if (fault === "capability") data.capabilities.fleetStatus.version = 2;
					if (fault === "session") data.session.sessionId = "wrong";
					nativeReply(picker, request, data);
				} else nativeReply(picker, request, { fleet: { version: 1, entries: [], totalActive: fault === "fleet" ? -1 : 0, omitted: 1 } });
			});
			const result = await settle(picker);
			assert.equal(result.continue, undefined, fault);
			assert.match(result.entries[0].content, /Compatibility blocker/);
			assert.equal(result.entries[0].details.isTaskComplete, false);
			assert.equal(result.entries[0].details.isActive, true);
			assert.equal((await modeStatus(picker)).details.isActive, true);
		} finally { await picker.dispose(); }
	}
});

test("a host without native tools needs no dependency, but missing advertised RPC is a bounded blocker", async () => {
	for (const presence of ["absent", "tool", "ready", "notice", "status-timeout"] as const) {
		const picker = await loadPicker("tui");
		try {
			await approveMode(picker);
			if (presence === "tool") picker.tools.set("subagent", { name: "subagent" });
			if (presence === "ready") picker.api.events.emit("subagents:rpc:v1:ready", nativePing());
			if (presence === "status-timeout") picker.api.events.on("subagents:rpc:v1:request", (raw) => {
				const request = raw as any;
				if (request.method === "ping") nativeReply(picker, request, nativePing());
			});
			const event = settleEvent();
			if (presence === "notice") event.context.contextMessages.push({ role: "custom", customType: "subagent-notify", content: "" });
			const result = await settle(picker, event);
			assert.equal(result.continue === true, presence === "absent");
			assert.equal((await modeStatus(picker)).details.isActive, true);
			assert.equal(picker.emitted.filter(({ channel }) => channel === "subagents:rpc:v1:request").length, presence === "status-timeout" ? 2 : 1);
		} finally { await picker.dispose(); }
	}
});

test("native reminder ownership and later-hook exhaustion cannot be restarted by autonomous mode", async () => {
	for (const customType of ["subagent-supervisor-blocked", "subagent-completion-unhandled"]) {
		const picker = await loadPicker("tui");
		try {
			configureNative(picker);
			await approveMode(picker);
			const event = settleEvent();
			event.context.contextMessages.push({ role: "custom", customType: customType === "subagent-supervisor-blocked" ? "subagent_supervisor_request" : "subagent-notify", content: "" });
			assert.equal(await settle(picker, event), undefined);
			assert.equal(picker.emitted.some(({ channel }) => /complete|wake|bg_wait/.test(channel)), false);
			const nativeEntry = { type: "custom_message", customType, timestamp: new Date().toISOString(), content: "", details: { blocked: true } };
			picker.branch.push(nativeEntry);
			picker.lifecycleHandlers.get("agent_settled")?.({}, picker.ctx);
			assert.equal((await modeStatus(picker)).details.isActive, true);
			assert.match(picker.notices.at(-1)!, /Native reminder budget exhausted/);
			assert.equal(picker.branch.at(-1).data.isTaskComplete, false);
			assert.equal((await settle(picker)).continue, undefined);
			const composed = await settle(picker, { ...settleEvent(), entries: [nativeEntry] });
			assert.equal(composed.continue, undefined);
			assert.equal(composed.entries.at(-1).details.isTaskComplete, false);
			assert.equal((await modeStatus(picker)).details.isActive, true);
		} finally { await picker.dispose(); }
	}
});
