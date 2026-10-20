# pi-ask-user

A Pi extension that gives the agent one tool, `ask_user_question`, to ask you one question and wait for your answer.

## What it does

- **Three answer modes.** Pick one option, pick several (`multiSelect: true`), or type free text when no options are given.
- **Other is always available.** Every option list has an Other choice, so you are never stuck with the agent's options.
- **Recommended first.** The agent puts its recommended option first and marks it.
- **Clipboard paste.** Paste text or an image into a free-text answer.
- **Subagent routing.** A child session's question goes to the main interactive session through Pi's event bus. One question shows at a time, and the others wait in a queue.
- **Secure field.** With `secure: true`, the agent gets a handle such as `{{secret:3f9a01bc}}`, never the value. The value shows as you type, and Ctrl+T masks it. Later tool results that contain a value of 8 or more characters show its handle instead. The extension emits `ask-user-question:secret` with `{ handle, value }` on Pi's in-process event bus, so another extension, such as pi-credentials, can use or save it. Handles end with the Pi session.
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
| `secure` | boolean, optional | Collect a secret. Free text only. Returns a handle, not the value. |

## Test

```sh
npm test
```

## License

MIT
