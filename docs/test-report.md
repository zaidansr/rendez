# Rendez verification report

## Result

Final local run on Windows with Node 24.22.1: **3 tests passed, 0 failed**.

```text
node --test tests/integration.test.cjs tests/electron.e2e.cjs
✔ two independent Electron profiles complete shared UI workflow
✔ authenticated collaboration, event recovery and persistent versions
✔ mock OpenAI HTTP adapter: owner keys, runs, cancellation and conflicts
tests 3; pass 3; fail 0
```

Run the suites separately with `npm test` and `npm run test:e2e`. The desktop suite uses the official Playwright Electron driver and the installed Electron executable. Localhost test processes required an unsandboxed shell in the Codex environment because its command sandbox blocked loopback connections. Tests use temporary SQLite databases and a test-only local HTTP server that implements the OpenAI Responses stream shape. They never contact OpenAI.

## Checks exercised

| Area | Observed assertions |
| --- | --- |
| Identity and access | Three independent accounts; distinct session cookies; signed-out and expired sessions denied; cross-origin mutation denied; outsider rejected from state, messages, agents, documents, versions, approvals, runs, and SSE. |
| Shared state | Two members joined by invite; author derived from session; messages visible across clients; retry ID returned the original message; changed payload with reused ID rejected; SSE replay delivered committed changes. |
| Documents | Immutable versions; stale base edit and stale approval returned 409; approval tied to reviewer and exact current version; a newer revision had no current approval; history and messages survived server restart. |
| Agent access | An agent's owner alone could start or cancel its run; an unconfigured owner received an error; user-specific test keys were sent only on that owner's provider requests; keys were absent from runtime/state responses, SQLite database and WAL files, and server output. Credentials cleared on restart. |
| Provider lifecycle | Test-only Responses stream completed conversation and document runs; request retry did not duplicate provider execution; arbitrary three-character stream fragments with CRLF parsed; HTTP failure and incomplete stream failed safely; cancellation committed no late message; a human edit during a document run preserved the human head and retained the agent output as a conflict; restart marked an in-flight run failed and replay did not reexecute it. |
| Desktop | Two actual Electron profiles held different signed-in users; invited user joined; both sent messages and saw remote updates; both configured keys and owned agents; each completed a document revision through the local provider; a human saved the final revision; dirty editor disabled approval; review showed the exact version text; approval appeared on both profiles; light and dark views rendered. |

Desktop captures from the final grayscale build: [light view](screenshots/desktop-light.png) and [dark view](screenshots/desktop-dark.png). The fields used dummy test credentials and the key inputs were empty when captured.

## Limitations

The provider tests validate the actual HTTP adapter against a deterministic local Responses-compatible server. **No live OpenAI run was performed** because no user API key was supplied. They do not establish live credential validity, model availability, billing behavior, or provider latency. The deployment target tested here is the trusted local-host MVP described in the implementation plan; internet deployment was outside this milestone.

