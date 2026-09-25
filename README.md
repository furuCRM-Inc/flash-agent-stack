# ⚡ FlashAgent Stack

> Local open-source drop-in for TypeSafe AI Jev · Universal WebMCP Chrome Extension · Deployable on Salesforce Sites, Cloudflare Workers, Vercel, and Railway.  
> **Community Edition: 100% free. Zero infrastructure cost. Runs anywhere.**

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://dash.cloudflare.com)
[![Deploy to Vercel](https://img.shields.io/badge/Deploy%20to-Vercel-000000?logo=vercel&logoColor=white)](https://vercel.com/new)
[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Salesforce Sites](https://img.shields.io/badge/Salesforce-Sites%20Ready-00A1E0?logo=salesforce&logoColor=white)](./apps/salesforce)

---

## Why this exists

[TypeSafe AI Jev](https://typesafe.ai) is brilliant: System 1 AI that answers **Noul / Choice / Score** questions in 70–500ms with zero output tokens and zero hallucination. But it's a paid cloud API.

FlashAgent Stack gives you the same interface — **fully Jev-compatible** — running locally or on Cloudflare Workers' free tier with a 40 MB NLI model and zero per-token cost.

---

## Three components

### 1. Backend — Jev-compatible API (Bun · Cloudflare Workers · Vercel · Railway)

`POST /v1/systemone` accepts the exact Jev request format and returns calibrated Noul / Choice / Score answers.

```bash
# Local (Bun)
cd apps/backend && bun install && bun run dev
# → http://localhost:3000

# Cloudflare Workers (FREE — zero cold starts, 100k req/day)
npx wrangler deploy

# Vercel
vercel --cwd apps/backend
```

**Request** (identical to TypeSafe AI Jev):
```json
{
  "model": "flash-local",
  "state": "{\"message\": \"System down. Lost $50,000. Cancel NOW!\", \"tier\": \"Enterprise\"}",
  "questions": {
    "is_critical":        { "type": "noul",   "instructions": "Critical VIP churn risk?" },
    "recommended_action": { "type": "choice",  "instructions": "Best retention action?", "criteria": { "APPROVE_MAX_REFUND": "Full refund", "ESCALATE": "Escalate", "STANDARD_RESPONSE": "Standard" } },
    "urgency_level":      { "type": "score",   "instructions": "Rate urgency 0–3.", "levels": { "0": "Low", "1": "Medium", "2": "High", "3": "Critical" } }
  }
}
```

**Response:**
```json
{
  "model": "flash-local",
  "answers": {
    "is_critical":        { "type": "noul",   "noul": 0.89 },
    "recommended_action": { "type": "choice",  "choice": "APPROVE_MAX_REFUND", "confidence": 0.82 },
    "urgency_level":      { "type": "score",   "score": 2.61, "confidence": 0.74 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 0 }
}
```

---

### 2. Salesforce Sites — Full LWC Demo (deployable to `furucrm` Experience Cloud)

Two LWCs that deploy directly to any Salesforce Site or App Page:

- **`flashAgentDemo`** — gorgeous Apple/Vercel-style demo UI with auto-detecting inference mode
- **`webMcpBridge`** — registers Salesforce actions as AI-callable tools via `document.modelContext`

**Auto-detection cascade:**
```
🟢 EDGE  → Web Worker (Transformers.js in-browser, ~10ms)
🔵 API   → Apex Callout → FlashAgent backend (~50–150ms)
⚪ SIM   → Hardcoded fallback, no infra required
```

```bash
cd apps/salesforce
sf project deploy start --source-dir force-app --target-org <alias>
```

---

### 3. Chrome Extension — Universal WebMCP Bridge

Injects `document.modelContext` into **any** web page — Salesforce, ServiceNow, Zendesk, your internal tools.

```javascript
// Works in any web app after installing the extension:
document.modelContext.registerTool({
  name: 'approve_refund',
  description: 'Process immediate VIP retention refund',
  execute: async (args) => myBackend.processRefund(args)
});
```

```bash
cd apps/extension && npm install && npm run build
# Load unpacked from apps/extension/ in Chrome → chrome://extensions/
```

---

### 4. FlashBar AI — Natural-Language SOQL Engine & JEV Feature Endpoints

The same Cloudflare Worker (`apps/backend/src/cf-worker.ts`) also runs the full backend
for **[FlashBar AI](https://github.com/furuCRM-Inc/furu-agent-bar)**, a `Cmd+K` command
palette for Salesforce Lightning Experience. This is the largest single surface in the
Worker — everything below ships from this repo, deployed with the same `npm run deploy:cf`
above.

**Natural-language → SOQL pipeline**
- `POST /v1/agent-action` — the main entry point. Classifies free-text input (English or
  Japanese) into an intent — `NAVIGATE`, `SOQL_SEARCH`, `UPDATE_RECORD`, `PREFILL`,
  `EXTRACT`, `GUIDE_CREATE`, `EXPLAIN_FIELD`, `EXPLAIN_FORMULA`, `DISAMBIGUATE`, or
  `CLARIFY` — and, for searches, compiles it straight into a validated SOQL filter
  (field/operator/value conditions, `ORDER BY`, date-literal detection, cross-object
  dot-notation fields like `Account.Name`). Runs a 3-tier confidence gate:
  ≥85% executes directly, 50–84% returns "Did you mean?" candidates, <50% falls back to
  a SOSL keyword search rather than guessing.
- `POST /v1/jev-classify` — lower-level Jev template/low-confidence classification used
  internally by the agent-action pipeline.
- Built-in semantic layers: Case status (`IsClosed` vs. `CreatedDate`, "クローズ済み" /
  "closed cases"), date-literal detection (`THIS_MONTH`, `来月`, `LAST_N_DAYS:N`, ...),
  ranking queries ("top 10 highest Amount"), and relationship/parent-child filter scoping.

**JEV feature endpoints** (Score / Choice / Noul — the AI judges, Salesforce Apex always
executes the actual DML under `WITH USER_MODE`)
- `POST /api/jev/triage` — Smart Case Triage: scores urgency/churn risk, recommends a
  support queue, flags cases needing immediate escalation.
- `POST /api/jev/qualify-batch` — Lead Qualify & Assign: ICP-scores a batch of Leads
  (HOT/WARM/COLD + reasoning) for round-robin assignment. Called in small parallel
  chunks rather than one big batch, since one large LLM prompt scales badly and turns
  into an all-or-nothing timeout.
- `POST /v1/translate-rule` — turns a raw Apex validation-rule error into a plain-English
  (or Japanese) rule for FlashBar's self-learning knowledge base, pending admin approval.
- `POST /v1/explain-formula` — plain-language explanation of a formula field.
- `POST /v1/jp-address` — Japanese postal-code lookup (7-digit zip → prefecture/city/town)
  via Zipcloud, used for address auto-fill and OCR postal-code enhancement.
- `POST /v1/csv-map` — AI-assisted column mapping for CSV bulk import.
- `POST /v1/dashboard-builder` — natural-language → Report/Dashboard scaffolding, gated
  behind a connected Claude API key (`/claude/save-key`, `/claude/status`).

All of the above honor a `userLanguage` field (`en`/`ja`) and return `reasoning`/label
text in that language — including a repetition-penalty tune on the LLM call, since
low-temperature decoding on the quantized model this runs on (`llama-3.1-8b-instruct-fp8`)
can otherwise spiral into a repeated-phrase loop on non-English output.

**KV cache seeding** (called once per session by the LWC, not user-facing)
`/v1/schema-seed`, `/v1/sobjects-seed`, `/v1/synonyms-seed`, `/v1/field-types-seed`,
`/v1/child-rels-seed`, `/v1/grammar-rules-seed`, `/v1/datacloud-catalog-seed` — push the
org's schema, custom-object catalog, and label synonyms into Cloudflare KV so field
validation and object-name resolution are sub-millisecond instead of round-tripping to
Salesforce on every keystroke.

See `furu-agent-bar`'s own README for the Salesforce-side install, permission sets, and
UI. FlashBar's unlocked package doesn't include Agentforce Vision OCR (needs
`ConnectApi.EinsteinLLM`, which isn't grantable in the org Salesforce uses to validate
package versions) — the Worker-side callout for it isn't in this list because the
Salesforce Apex class that would call it ships outside the package instead.

---

## Deploy to Cloudflare Workers in 30 seconds

```bash
# 1. Clone the repo
git clone https://github.com/furuCRM-Inc/flash-agent-stack
cd flash-agent-stack/apps/backend

# 2. Install dependencies
npm install

# 3. Authenticate with Cloudflare
npx wrangler login

# 4. Deploy (uses Workers AI — @cf/facebook/bart-large-mnli, built-in, free)
npm run deploy:cf
# → https://flash-agent-stack.your-account.workers.dev
```

**Copy the deployment URL** → paste it into Salesforce:
- `Setup → Named Credentials → FlashAgent_Backend → Edit → Endpoint`
- `Setup → Remote Site Settings → FlashAgent_Backend → Edit → Remote Site URL`

---

## Connect to Salesforce Sites (furucrm)

After deploying the Cloudflare Workers backend:

```bash
# Deploy LWC + Apex to your org
cd apps/salesforce
sf project deploy start --source-dir force-app --target-org furucrm

# Add CSP Trusted Sites in Salesforce Setup:
# Setup → CSP Trusted Sites → New
#   URL: https://cdn.jsdelivr.net      (Transformers.js CDN)
#   URL: https://huggingface.co        (NLI model download)
```

---

## Latency comparison

| Scenario | TypeSafe AI Jev (cloud) | FlashAgent Edge (browser) | FlashAgent CF Workers |
|---|---|---|---|
| Cold start | — | ~3s (model download, once) | 0ms (no cold start) |
| Warm inference | 70–500ms | **10–50ms** | **20–80ms** |
| Output tokens | 0 | 0 | 0 |
| Cost per 1M requests | ~$42 | **$0** | **$0** |
| Data leaves your network | Yes | **No** | Cloudflare edge only |

---

## Architecture

```
Agent / LLM client
    │
    ├─ POST /v1/systemone (Jev-compatible)
    │       │
    │       ├─ Bun + Transformers.js NLI (local, 10–50ms)
    │       └─ Cloudflare Workers AI (edge, 20–80ms, free)
    │
    └─ Salesforce Sites (furucrm)
            │
            ├─ flashAgentDemo LWC
            │   ├─ EDGE: Web Worker → flashAgentWorker.js (Transformers.js)
            │   └─ API:  Apex → JevReflexController → Named Credential
            └─ webMcpBridge LWC
                └─ document.modelContext.registerTool()
                    ├─ approve_refund()
                    ├─ reroute_case()
                    └─ generate_resolution_message()
```

---

## Project structure

```
flash-agent-stack/
├── apps/
│   ├── backend/                    # Hono + Transformers.js API
│   │   ├── src/
│   │   │   ├── index.ts            # Bun / Node.js entry (local dev)
│   │   │   ├── cf-worker.ts        # Cloudflare Workers entry (Workers AI)
│   │   │   ├── types.ts            # Jev-compatible type definitions
│   │   │   ├── engine/
│   │   │   │   ├── classifier.ts   # Transformers.js NLI singleton
│   │   │   │   └── evaluators.ts   # Noul / Choice / Score evaluators
│   │   │   └── routes/
│   │   │       ├── systemone.ts    # POST /v1/systemone
│   │   │       └── completions.ts  # POST /v1/chat/completions
│   │   ├── wrangler.toml           # Cloudflare Workers config
│   │   └── vercel.json             # Vercel config
│   ├── extension/                  # Chrome Extension (Manifest V3)
│   │   └── src/
│   │       ├── inject.ts           # Creates window.modelContext in page
│   │       ├── content.ts          # postMessage ↔ chrome.runtime bridge
│   │       └── background.ts       # Tool registry + proxy service worker
│   └── salesforce/                 # Salesforce DX (LWC + Apex)
│       └── force-app/main/default/
│           ├── lwc/
│           │   ├── flashAgentDemo/ # Main Salesforce Sites demo UI
│           │   └── webMcpBridge/   # WebMCP tool registration
│           ├── classes/
│           │   └── JevReflexController.cls  # Apex callout + simulation fallback
│           └── staticresources/
│               └── flashAgentWorker.js      # In-browser NLI Web Worker
├── enterprise/
│   └── README.md                   # Enterprise support & pricing
├── mcp-schema.json                 # JSON Schema for /v1/systemone
└── package.json                    # npm workspaces root
```

---

## Swap Jev ↔ FlashAgent instantly

Only change the Named Credential endpoint — no code changes:

```
# TypeSafe AI (cloud)      → callout:TypeSafe_Jev/v1/systemone
# FlashAgent CF Workers    → callout:FlashAgent_Backend/v1/systemone
# FlashAgent local         → http://localhost:3000/v1/systemone
```

---

## Pricing & Support

FlashAgent Stack is 100% open source (MIT) and self-hosted — you deploy and run
every piece of it yourself (Cloudflare Workers, Vercel, your own Salesforce org),
so there's no infrastructure furuCRM operates on your behalf and nothing to pay
for the software itself.

| What | Details |
|---|---|
| License | MIT — free forever, no feature gating |
| Core engine (Noul/Choice/Score) | ✅ Included |
| Cloudflare Workers / Vercel / local deploy | ✅ Included |
| Salesforce LWC (Cases, Leads) | ✅ Included |
| Chrome Extension | ✅ Included |
| Community support | GitHub Issues |

### Paid engagements — Work, not a license

Since you own the deployment, there's nothing to sell you *access* to. What we
do offer as paid work:

| Engagement | What it covers |
|---|---|
| Custom model fine-tuning | Tuning a model for your domain's Noul/Choice/Score accuracy |
| Feature / LWC extension | New components or JEV endpoints built for your workflow (in the style of `flashAgentDemo`/`webMcpBridge`, or FlashBar's own Case Triage / Lead Qualify endpoints) |
| Salesforce integration support | Hands-on help wiring this into a production org — Named Credentials, permission sets, package deployment |

**Need custom model work, a feature extension, or integration support?**  
→ Email [contact@furucrm.com](mailto:contact@furucrm.com) or visit **[furucrm.com](https://furucrm.com)**

---

## Related

- [400ms-agentic-sf](https://github.com/furuCRM-Inc/400ms-agentic-sf) — Full Salesforce demo using Jev + WebMCP resolving a $50K VIP crisis in 400ms
- [dc-semantic-layer](https://github.com/furuCRM-Inc/dc-semantic-layer) — Operational semantic layer for Salesforce Data Cloud
- [TypeSafe AI Jev](https://typesafe.ai) — The cloud System 1 AI that inspired this project

---

## License

MIT — use freely in commercial projects. See [enterprise/README.md](./enterprise/README.md) for production support options.
