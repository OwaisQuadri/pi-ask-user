# pi-ask-user

A Pi extension that gives the agent one tool, `ask_user_question`, to ask you one question and wait for your answer.

## What it does

- **Three answer modes.** Pick one option, pick several (`multiSelect: true`), or type free text when no options are given.
- **Other is always available.** Every option list has an Other choice, so you are never stuck with the agent's options.
- **Recommended first.** The agent puts its recommended option first and marks it.
- **Clipboard paste.** Paste text or an image into a free-text answer.
- **Subagent routing.** A child session's question goes to the main interactive session through Pi's event bus. One question shows at a time, and the others wait in a queue.
- **Herdr status.** The extension emits `herdr:blocked` while it waits for you, so your workspace shows that the agent needs you.

## Install

Install from this repository's Git URL:

```sh
pi install git:<this repository URL without https://>
```

## Tool parameters

| Parameter | Type | Purpose |
|---|---|---|
| `question` | string | The single question. Ask one question per call. |
| `details` | string, optional | Context shown under the question. |
| `options` | array, optional | `{ label, value?, description? }`. Omit for free text. |
| `multiSelect` | boolean, optional | Allow more than one answer. |

## Test

```sh
npm test
```

## License

MIT
