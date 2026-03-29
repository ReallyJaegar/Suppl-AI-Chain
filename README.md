# Order Intake AI — Backend

AI-powered order intake automation. Monitors email inboxes, extracts structured PO data using Claude, maps SKUs, handles exceptions, and syncs to ERP systems.

---

## Architecture

```
Inbox (Gmail / Outlook)
        │
        ▼
  Inbox Poller          ← polls every 2 min via cron
        │
        ▼
 Extraction Service     ← Claude API: email → structured JSON
        │
        ├── SKU Mapper  ← exact / fuzzy / AI match → internal SKU
        │
        ├── Validator   ← checks required fields, price rules
        │
        └── Exception Handler
                │  touchless=true         │  touchless=false
                ▼                         ▼
          ERP Router              Clarification Email
         /    |    \              (sent back to customer)
    NetSuite  QB  CSV/Webhook
```

---

## Quick Start

```bash
cd backend
cp .env.example .env
# Fill in at minimum: ANTHROPIC_API_KEY

npm install
npm run dev
```

Server starts on `http://localhost:3000`

---

## API Reference

### Parse an order (manual / API)

```bash
curl -X POST http://localhost:3000/api/orders/parse \
  -H "Content-Type: application/json" \
  -d '{
    "from": "buyer@customer.com",
    "subject": "PO #1234",
    "date": "2025-03-15",
    "body": "Please send 48 units of Dark Roast 5lb at $18.50 each. Ship to 123 Main St, Columbus OH 43215. PO #1234. Delivery by March 20."
  }'
```

### Parse a file upload

```bash
curl -X POST http://localhost:3000/api/orders/parse-file \
  -F "file=@order.pdf" \
  -F "from=buyer@customer.com"
```

### List orders

```bash
# All orders
curl http://localhost:3000/api/orders

# Only exceptions
curl "http://localhost:3000/api/orders?status=exception"
```

### Push to ERP

```bash
curl -X POST http://localhost:3000/api/orders/{id}/push \
  -H "Content-Type: application/json" \
  -d '{ "target": "csv" }'
  # targets: csv | webhook | netsuite | quickbooks
```

### Resolve an exception

```bash
curl -X PUT http://localhost:3000/api/orders/{id}/resolve \
  -H "Content-Type: application/json" \
  -d '{ "field": "shipTo", "value": "123 Main St, Columbus OH 43215" }'
```

---

## Gmail Setup

1. Create a project in [Google Cloud Console](https://console.cloud.google.com)
2. Enable Gmail API
3. Create OAuth 2.0 credentials (Desktop app)
4. Add `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` to `.env`
5. Visit `http://localhost:3000/auth/gmail` to authorize
6. Copy the refresh token from server logs → `GMAIL_REFRESH_TOKEN` in `.env`
7. In Gmail, create a label called `orders-inbox` and set up a filter to apply it

---

## Outlook Setup

1. Register an app in [Azure Portal](https://portal.azure.com) → App registrations
2. Add redirect URI: `http://localhost:3000/auth/outlook/callback`
3. Add API permission: `Mail.Read`, `Mail.Send` (delegated)
4. Add `OUTLOOK_CLIENT_ID`, `OUTLOOK_CLIENT_SECRET`, `OUTLOOK_TENANT_ID` to `.env`
5. Visit `http://localhost:3000/auth/outlook` to authorize
6. Copy refresh token from logs → `OUTLOOK_REFRESH_TOKEN` in `.env`

---

## ERP Connectors

| Connector   | Status      | Notes                                              |
|-------------|-------------|--------------------------------------------------- |
| CSV         | ✅ Ready     | Always available, exports to `./data/exports/`    |
| Webhook     | ✅ Ready     | Set `ERP_WEBHOOK_URL` to a Zapier/Make endpoint   |
| NetSuite    | 🔧 Configure | Needs TBA credentials in `.env`                   |
| QuickBooks  | 🔧 Configure | Needs OAuth 2.0 credentials in `.env`             |

**Recommended order**: Start with CSV for all early customers. Add Webhook for Zapier-savvy customers. Build NetSuite first among native connectors.

---

## SKU Mapping

The `skuMapper` uses a three-tier lookup:

1. **Exact match** — checks `src/services/skuMapper.js` product catalog
2. **Fuzzy match** — token overlap score ≥ 0.6
3. **AI fallback** — Claude picks the best match from the catalog

To add products, edit the `PRODUCT_CATALOG` array in `skuMapper.js`. In production, replace this with a DB query against your product master.

---

## Project Structure

```
backend/
├── src/
│   ├── server.js                  # Express entrypoint
│   ├── config/
│   │   └── index.js               # Env var loader & validator
│   ├── api/
│   │   ├── orders.js              # REST routes for order operations
│   │   ├── auth.js                # Gmail + Outlook OAuth flows
│   │   └── webhooks.js            # Webhook registration + dispatch
│   ├── services/
│   │   ├── extractionService.js   # Claude AI extraction + file parsing
│   │   ├── skuMapper.js           # 3-tier SKU matching
│   │   ├── inboxPoller.js         # Gmail + Outlook scheduled polling
│   │   ├── orderStore.js          # File-based order persistence
│   │   ├── clarificationService.js # Auto-reply emails for exceptions
│   │   └── erpRouter.js           # Routes orders to correct connector
│   ├── connectors/
│   │   ├── netsuite.js            # NetSuite REST API (OAuth 1.0a TBA)
│   │   ├── quickbooks.js          # QuickBooks Online API (OAuth 2.0)
│   │   ├── csv.js                 # CSV file export
│   │   └── webhook.js             # Generic HTTP webhook push
│   └── utils/
│       ├── logger.js              # Structured JSON logger
│       └── asyncHandler.js        # Express async error wrapper
├── data/                          # Auto-created: orders.json, exports/
├── .env.example                   # Copy to .env and fill in
└── package.json
```

---

## Scaling Checklist (when you outgrow MVP)

- [ ] Replace `orderStore.js` file store with PostgreSQL (use `pg` or `drizzle-orm`)
- [ ] Move `processedIds` Set in `inboxPoller.js` to Redis
- [ ] Add a job queue (BullMQ) for high-volume parsing
- [ ] Add auth middleware to API routes (API key or JWT)
- [ ] Move secrets to AWS Secrets Manager / Doppler
- [ ] Containerize with Docker, deploy to Railway or Fly.io
