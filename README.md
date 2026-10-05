# Chargebee Webhook Viewer

Local Chargebee Product Catalog 2 webhook viewer, based on the Stripe viewer.

## Run

Requires Node.js 24.21.0, pnpm, and an installed/configured ngrok CLI.

```sh
nvm install
nvm use
pnpm install
pnpm start
```

Opens `http://localhost:4343` automatically. `pnpm start` builds before starting.
For development, use `pnpm dev`.

## Receive webhooks

Open **Chargebee controls**, then **Start** to run ngrok in the background.
The app shows tunnel status and output. **Stop** stops the tunnel; quitting the
app also stops its ngrok process.

The default command uses your existing config and reserved domain:

```sh
ngrok http --config=/Users/keogh/Dropbox/System/ngrok.yml --host-header=rewrite --url=https://keogh-billing-backend.eu.ngrok.io http://localhost:4343 --log=stdout --log-format=json
```

Set the Chargebee webhook URL to:

```text
https://keogh-billing-backend.eu.ngrok.io/webhook
```

Existing webhook paths also work: the viewer accepts POST deliveries at any
path except its own control API routes. Your old backend path can remain in
Chargebee. The tunnel now points at the viewer, which can then forward to your
backend. Only one ngrok process should own this reserved domain at a time.

Incoming Basic Auth is accepted without validation and retained for forwarding.
No Chargebee API key is required. Stripe expansion controls are omitted.

## Forward and resend

Enter the **full backend webhook URL**, including its path, under **Forward
webhook to**. Leave it empty to disable automatic forwarding.

Every received hook is acknowledged immediately and forwarded asynchronously.
**Resend** sends the currently selected stored hook to the current forwarding
URL, including after a page reload or app restart. It does not create another
history entry.

Forwarding and resends preserve the original raw JSON text, authorization and
other usable headers, and the original query string (including encoding,
duplicate keys and order). Query parameters already in the destination URL are
retained. The configured destination determines the host and path; transport
headers such as Host and Content-Length are regenerated. A viewer relay marker
prevents forwarding loops. Local backends with self-signed TLS certificates are
supported. Delivery status appears in the footer.

## Viewer

- Live updates through Server-Sent Events.
- Up to 500 hooks in browser storage, with rename/delete/delete-all.
- Event-type folders under resource sections (including compound PC2 names).
- Persisted folder/hook drag ordering and collapsed sections.
- Read-only Monaco JSON editor, folding, find, minimap and copy controls.
- **Copy JSON** copies the displayed payload; **Copy Content** copies `content`.
- Request metadata, headers, received time and Chargebee event metadata.
- Persisted sidebar sizing, collapse state and control panel preferences.
- Orange theme and Chargebee favicon; separate storage from the Stripe app.

History is stored in your browser; the server does not write payloads to disk.
If browser storage fills, the viewer retains the latest 100 or 25 hooks.
The forwarding URL is stored locally in `data/forwarding.json` (gitignored).

## Configuration

Environment variables:

| Variable | Default |
| --- | --- |
| `PORT` | `4343` |
| `HOST` | `localhost` |
| `NGROK_CONFIG` | `/Users/keogh/Dropbox/System/ngrok.yml` |
| `NGROK_URL` | `https://keogh-billing-backend.eu.ngrok.io` |
| `OPEN_BROWSER` | `true` (set `false` to disable) |

Changing `PORT` or `HOST` updates the tunnel upstream automatically.
