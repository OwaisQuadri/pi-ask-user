import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, ScrollView, SelectList, Text, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export function showApproval(ctx: ExtensionContext, summary: string, signal?: AbortSignal): Promise<string | undefined> {
	return ctx.ui.custom<string | undefined>((tui, theme, _keys, done) => {
		let isFinished = false;
		const finish = (choice?: string) => {
			if (isFinished) return;
			isFinished = true;
			signal?.removeEventListener("abort", onAbort);
			done(choice);
		};
		const onAbort = () => finish();
		const body = new ScrollView(new Text(summary, 0, 0), { scrollbar: "hidden" });
		const actions = new SelectList(["Cancel", "Edit scope", "Approve and start"].map((label) => ({ label, value: label })), 3, {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		});
		actions.onSelect = (item) => finish(item.value);
		actions.onCancel = () => finish();
		signal?.addEventListener("abort", onAbort, { once: true });
		if (signal?.aborted) onAbort();
		return {
			render(width: number) {
				const lines = body.render(width);
				const height = Math.max(1, Math.min(16, tui.terminal.rows - 13));
				body.updateLayout(lines.length, height, () => tui.requestRender());
				return [
					theme.fg("accent", "Approve autonomous work"),
					...lines.slice(body.scrollTop, body.scrollTop + height),
					theme.fg("dim", "─".repeat(Math.max(1, width))),
					...actions.render(width),
					theme.fg("dim", "Ctrl+U/D review · ↑↓ action · Enter select · Esc cancel"),
				].map((line) => truncateToWidth(line, width));
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.ctrl("u"))) body.scrollBy(-5);
				else if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.ctrl("d"))) body.scrollBy(5);
				else actions.handleInput(data);
				tui.requestRender();
			},
			invalidate() { body.invalidate(); actions.invalidate(); },
			dispose() { finish(); },
		};
	});
}
