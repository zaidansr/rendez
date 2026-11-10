# Rendez

Rendez is a local-first collaborative workspace for people and their AI agents. A Node server stores accounts, workspaces, messages, documents, approvals, agent definitions, runs, and replayable events in SQLite. The desktop window uses the same server as the browser client.

## Run

Requires Node.js 24 or newer and npm.

```bash
npm ci
npm run server
```

Leave the server running. In a second terminal, run `npm start` to open Electron, or open `http://127.0.0.1:4317` in a browser. The server binds to loopback by default. Electron connects to the separately running server.

To try two independent desktop accounts against one server, open two more terminals and run `npm start -- --profile=alice` and `npm start -- --profile=bob`. Each profile has its own session storage.

Run the API integration suite with `npm test`. It uses an isolated temporary database and a fake local provider, so it makes no live model calls.
Run the desktop flow on Windows with `npm run test:e2e`. It launches two isolated Electron profiles against a temporary server and local fake provider. The suite requires Electron's binary to be installed by `npm ci`.

The first person registers an account, creates a workspace, and shares its invite code with another registered user. Each person signs in through their own session. Workspace changes appear in connected clients via server-sent events; the event cursor allows replay after reconnecting. Data lives in `.data/rendez.sqlite` beside the source unless `RENDEZ_DATA_DIR` sets another directory. This directory is ignored by Git.

## API-backed agents

Rendez calls the OpenAI Responses API when an agent owner runs an agent. Each owner enters their own API key through the runtime settings in the app. The key is held **only in server memory**, is never included in workspace state, and is cleared on logout or server restart. No agent run is made without its owner's key. The runtime indicator means a key has been entered; it does not verify account access or model availability. API calls can incur charges on the key owner's account.

Agents cannot execute tools, read arbitrary files, or access the network beyond the configured model API. A run receives a bounded snapshot of workspace messages and documents, and its output is streamed into a durable run record. A run without a document target publishes an agent message when complete. A document run creates a new version only if the target is still at the version it started from. Conflicting output remains in the run for manual review. Approvals bind to an exact document version; revising a document does not transfer approval.

The provider endpoint is fixed at `https://api.openai.com/v1/responses`. `RENDEZ_OPENAI_RESPONSES_URL` is an operator-only override for local integration tests; it is never set by workspace users.

## Server settings and security boundaries

- `RENDEZ_PORT` changes the port (default `4317`).
- `RENDEZ_DATA_DIR` changes the durable data directory. Only one server process may open a data directory at a time.
- `RENDEZ_HOST` changes the bind address (default `127.0.0.1`). Binding outside loopback requires `RENDEZ_PUBLIC_ORIGIN` and an HTTPS reverse proxy. Do not expose plain HTTP sessions or API keys on a network.
- `RENDEZ_PUBLIC_ORIGIN` is the exact browser origin accepted by the server, such as `https://rendez.example.com`; it also enables `Secure` session cookies.

Sessions use HttpOnly SameSite Strict cookies. Requests are limited by host and origin, every workspace API checks membership, and agent runs and cancellations require agent ownership. Invite codes are random opaque values. Passwords use scrypt. Account and run endpoints are rate limited. The server serves only its three UI files; it does not provide arbitrary file reads.

This is a self-hosted milestone, not a managed cloud service. For separate machines, configure a trusted HTTPS reverse proxy, persistent storage, process supervision, backups, and an operator-managed deployment. The default loopback setup supports multiple local browser or desktop clients on one machine.
