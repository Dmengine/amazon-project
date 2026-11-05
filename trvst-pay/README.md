# TRVST PAY — paylinks

One shareable payment link that the payer can settle two ways:

| Payer picks | API suite | What happens |
|---|---|---|
| **Pay by card** | Global Payments GP API — `POST /accesstoken`, `POST /links` (Pay by Link) | Redirect to the Global Payments hosted card page. Card data never touches TRVST PAY. |
| **Pay by bank** | OpenPayd — `POST /api/oauth/token` (client credentials), then **Create PayIn** (open banking) | Redirect to the bank authorisation URL returned by the PayIn. |

The provider session is only created when the payer chooses a method, so an unused method doesn't leave an open session. Status comes back through webhooks and the payer lands on a TRVST PAY return page.

It needs Node 20 or later. Its one dependency is [`qrcode`](https://www.npmjs.com/package/qrcode), which generates the QR codes (`npm install`).

## Run it

```bash
cd trvst-pay
npm test                       # unit + adapter tests (fake provider servers)
npm start                      # mock mode on http://localhost:4242
```

In **mock** mode (the default) both providers are simulated, so you can click through the whole flow without credentials. For real sandbox calls, copy `.env.example` to `.env`, fill in the OpenPayd and GP API credentials, set `TRVST_PAY_MODE=live` and run `node --env-file=.env src/server.js`.

The storefront's checkout page (`checkout.html`) has a **Pay with TRVST PAY** button. It creates a paylink for the order total and shows the QR code (to pay on a phone) next to a **Pay in this browser** button. Checkout polls the link and goes to the orders page once it's paid. The payer page also has a **Pay on your phone instead** QR code for desktop users. To try it, serve the repo root on port 5500 (e.g. `python3 -m http.server 5500`) while the service is running.

## API

All `/api/*` calls need `Authorization: Bearer $TRVST_PAY_API_KEY` when that variable is set.

### Create a paylink

```http
POST /api/paylinks
{
  "amount": 4999,                 // minor units
  "currency": "GBP",              // GBP | EUR | USD
  "reference": "ORDER-1001",      // unique, 1-35 chars [A-Za-z0-9-_.]
  "description": "Order 1001",
  "customer": { "name": "Ada Lovelace", "email": "ada@example.com" },
  "methods": ["card", "bank"],    // optional, default both
  "expiresInHours": 72,           // optional, max 720
  "returnUrl": "https://shop.example/orders"   // optional "Return to merchant" link
}
→ 201 { "id": "pl_…", "url": "https://pay.trvst…/pay/pl_…", "status": "open", … }
```

Send the payer the `url`. The response also includes:

| Field | What it's for |
|---|---|
| `qrCodeUrl` / `qrCodePngUrl` | QR code of the link as SVG or PNG. PNG takes `?size=128…2048`. Print it, or show it on a screen at the counter. |
| `shareUrl` | Merchant share page: QR code, pay button, copyable link and embed code, plus SVG/PNG downloads |
| `buttonHtml` | Ready-to-paste "Pay … with TRVST PAY" button with the QR code under it. Inline styles only, so it also works in HTML email. |

| Endpoint | Purpose |
|---|---|
| `GET /api/paylinks/:id` | Full status, including each provider attempt |
| `POST /api/paylinks/:id/cancel` | Cancel an open link |
| `GET /pay/:id` | Hosted page for the payer |
| `GET /pay/:id/status` | Public `{id, status, paidWith}` for polling (CORS-enabled for the allowed origins) |
| `GET /pay/:id/qr.svg`, `GET /pay/:id/qr.png?size=512` | QR code of the paylink URL |
| `GET /pay/:id/share` | Share page with the button, QR code and embed code |
| `POST /webhooks/globalpayments` | GP `status_url`. Verified with `X-GP-Signature` = SHA-512(body + app key) |
| `POST /webhooks/openpayd` | OpenPayd callback. HMAC-SHA256 with `OPENPAYD_WEBHOOK_SECRET` if set; otherwise the PayIn is read back from OpenPayd and the request body isn't trusted |

A paylink's status is one of `open`, `paid`, `expired` or `cancelled`.

## Check against the provider docs before going live

The provider docs couldn't be reached when this was built, so these are configurable rather than hard-coded:

- **OpenPayd PayIn path and body:** `OPENPAYD_PAYIN_PATH` (default `/api/transactions/open-banking/payins`) and the field names in `src/providers/openpayd.js` (`accountId`, `amount{value,currency}`, `redirectUrl`, `callbackUrl`). The response URL is read from `authorisationUrl` / `redirectUrl` / `paymentUrl` / `url`.
- **OpenPayd webhook signature header:** `X-Signature` is assumed.
- **GP API version and account name:** `GP_API_VERSION` and `GP_ACCOUNT_NAME`. The webhook payload fields are mapped in `parseWebhook`.

## Production notes

- Create paylinks from the merchant **backend** with the API key. The storefront button calls the API directly from the browser only for local development.
- `src/store.js` is a single-instance JSON file. Replace it with a database before running more than one instance.
