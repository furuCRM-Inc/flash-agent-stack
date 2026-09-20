# ⚡ FlashAgent Stack

> Local, open-source drop-in for TypeSafe AI Jev + Universal WebMCP Chrome Extension.  
> Run structured AI decisions at **10–50ms** on your own hardware — no API key, no cloud, no cost.

---

## Why this exists

[TypeSafe AI Jev](https://typesafe.ai) is brilliant: System 1 AI that answers Noul/Choice/Score questions in 70–500ms with **zero output tokens**. No hallucination. No text generation.

But it's a paid cloud API. FlashAgent Stack gives you the same interface — fully Jev-compatible — running **locally** with [Transformers.js](https://github.com/xenova/transformers.js) and a 40 MB NLI model.

---

## Two components

### 1. Backend — Jev-compatible API server

`POST /v1/systemone` accepts the exact same request format as TypeSafe AI and returns calibrated Noul / Choice / Score answers.

```
POST http://localhost:3000/v1/systemone
```

**Request** (identical to Jev API):
```json
{
  "model": "flash-local",
  "state": "{\"message\": \"System down. Lost $50,000. Cancel NOW!\", \"tier\": \"Enterprise\"}",
  "questions": {
    "is_critical": {
      "type": "noul",
      "instructions": "Does this require immediate VIP retention intervention?"
    },
    "recommended_action": {
      "type": "choice",
      "instructions": "Select the most appropriate retention action.",
      "criteria": {
        "APPROVE_MAX_REFUND": "Approve full refund immediately for VIP retention",
        "ESCALATE":           "Escalate to senior support team",
        "STANDARD_RESPONSE":  "Route to standard support queue"
      }
    },
    "urgency_level": {
      "type": "score",
      "instructions": "Rate the urgency of this customer situation.",
      "levels": {
        "0": "Low: No immediate churn risk",
        "1": "Medium: Same-day response needed",
        "2": "High: Priority response within the hour",
        "3": "Critical: High-value customer threatening cancellation"
      }
    }
  }
}
```

**Response** (Jev-compatible format):
```json
{
  "model": "flash-local (flash-local)",
  "answers": {
    "is_critical":        { "type": "noul",   "noul": 0.89 },
    "recommended_action": { "type": "choice",  "choice": "APPROVE_MAX_REFUND", "confidence": 0.82, "probabilities": { "APPROVE_MAX_REFUND": 0.82, "ESCALATE": 0.13, "STANDARD_RESPONSE": 0.05 } },
    "urgency_level":      { "type": "score",   "score": 2.61, "confidence": 0.74 }
  },
  "usage": { "input_tokens": 312, "output_tokens": 0 }
}
```

**Also available:** `POST /v1/chat/completions` — OpenAI-compatible endpoint.

---

### 2. Chrome Extension — Universal WebMCP Bridge

Injects `document.modelContext` (WebMCP protocol) into **any** web page — Salesforce, ServiceNow, Zendesk, your internal tools.

```javascript
// Works in any web app, no SDK needed:
document.modelContext.registerTool({
  name: 'approve_refund',
  description: 'Process immediate VIP retention refund',
  inputSchema: {
    type: 'object',
    properties: { amount: { type: 'number' }, caseId: { type: 'string' } },
    required: ['amount']
  },
  execute: async (args) => myBackend.processRefund(args)
});
```

Agents call tools by name — no screenshot, no DOM scraping, no fragile selectors.

---

## Architecture

```
Agent / LLM Client
       │
       ▼ POST /v1/systemone
FlashAgent Backend (Hono + Bun)
       │
       ▼ zero-shot-classification
Transformers.js NLI Model
  (Xenova/nli-deberta-v3-small, ~40MB, runs in-process)
       │
       ▼ Noul / Choice / Score answers

Chrome Extension
  inject.ts   → creates window.modelContext in page
  content.ts  → bridges postMessage ↔ chrome.runtime
  background.ts → maintains tool registry, proxies calls
```

---

## Latency comparison

| Scenario | Jev (cloud) | FlashAgent (local) |
|---|---|---|
| Cold start | — | ~3s (model load, once only) |
| Warm inference | 70–500ms | **10–50ms** |
| Output tokens | 0 (free) | 0 |
| Hallucination | None | None |
| Cost | $0.042/1M tokens | **$0** |
| Privacy | Data leaves your network | **Stays local** |

---

## Quick Start

### Backend

**With Bun (recommended — fastest):**
```bash
cd apps/backend
bun install
bun run dev
# → http://localhost:3000
```

**With Node.js:**
```bash
cd apps/backend
npm install
npm run start:node
# → http://localhost:3000
```

**Test it:**
```bash
curl -X POST http://localhost:3000/v1/systemone \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "flash-local",
    "state": "{\"message\": \"Cancel my account, this is unacceptable!\", \"tier\": \"Enterprise\"}",
    "questions": {
      "is_critical": { "type": "noul", "instructions": "Is this a critical churn risk?" },
      "action": { "type": "choice", "instructions": "Best retention action?", "criteria": { "REFUND": "Offer full refund", "ESCALATE": "Escalate to manager", "STANDARD": "Standard support" } }
    }
  }'
```

### Chrome Extension

```bash
cd apps/extension
npm install
npm run build
```

1. Open Chrome → `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `apps/extension/`
4. Visit any page — `document.modelContext` is now available

---

## Swap Jev ↔ FlashAgent in Salesforce

In your Named Credential, just change the endpoint:

```
# Production (TypeSafe AI)
https://api.typesafe.ai

# Local development (FlashAgent)
http://localhost:3000
```

The request/response format is identical. No code changes needed.

---

## Model

Default: `Xenova/nli-deberta-v3-small`  
- Size: ~40 MB (downloaded once to `~/.cache/huggingface`)  
- Task: Natural Language Inference (zero-shot classification)  
- Latency: 10–50ms per question set (CPU), 5–15ms (GPU)

Switch to a larger model for higher accuracy:
```bash
MODEL=Xenova/nli-deberta-v3-large bun run dev
```

---

## Integrating with agents

### Claude Desktop (MCP)

Point any MCP tool at `http://localhost:3000/v1/systemone`.  
The [mcp-schema.json](./mcp-schema.json) in this repo defines the full input schema.

### LangChain / LlamaIndex

```python
import requests

def flash_decision(state: str, questions: dict) -> dict:
    return requests.post(
        "http://localhost:3000/v1/systemone",
        json={"model": "flash-local", "state": state, "questions": questions}
    ).json()
```

### Agentforce / Salesforce

Replace `callout:TypeSafe_Jev` with a Named Credential pointing to your FlashAgent instance.

---

## Project structure

```
flash-agent-stack/
├── apps/
│   ├── backend/               # Hono + Transformers.js API server
│   │   └── src/
│   │       ├── index.ts       # Entry point
│   │       ├── types.ts       # Jev-compatible type definitions
│   │       ├── engine/
│   │       │   ├── classifier.ts   # Transformers.js NLI singleton
│   │       │   └── evaluators.ts   # Noul / Choice / Score evaluators
│   │       └── routes/
│   │           ├── systemone.ts    # POST /v1/systemone
│   │           └── completions.ts  # POST /v1/chat/completions
│   └── extension/             # Chrome Extension (Manifest V3)
│       └── src/
│           ├── inject.ts      # Creates window.modelContext in page
│           ├── content.ts     # postMessage ↔ chrome.runtime bridge
│           └── background.ts  # Tool registry + proxy service worker
├── mcp-schema.json            # JSON Schema for /v1/systemone
└── package.json               # npm workspaces root
```

---

## Related

- [400ms-agentic-sf](https://github.com/furuCRM-Inc/400ms-agentic-sf) — Full Salesforce demo using Jev + WebMCP
- [dc-semantic-layer](https://github.com/furuCRM-Inc/dc-semantic-layer) — Operational semantic layer for Data Cloud
- [TypeSafe AI Jev](https://typesafe.ai) — The cloud System 1 AI that inspired this project

---

## License

MIT — use freely in commercial projects.
