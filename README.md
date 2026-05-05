# apimock — Instant API Mocking CLI

Spin up a mock HTTP server from an OpenAPI spec in seconds. No boilerplate, no config files required.

```bash
npx apimock serve --spec ./api.json --mode random --latency realistic
```

---

## Features

- **Empty mode** — deterministic zero-values, identical on every request (great for snapshot tests)
- **AI mode** — Phase 2 preview: realistic responses generated via OpenRouter, with cache, retry, and random fallback support
- **Random mode** — schema-valid varied data with semantic field inference (`email` → real email, `price` → monetary value, etc.)
- **Latency simulation** — fixed, range, log-normal distribution, or presets (`realistic`, `slow-3g`, `db-heavy`)
- **Spec validation** — validate OpenAPI specs with line-level error messages before starting the server
- **Live proxy** — forward requests to a real upstream API and optionally record to HAR
- **HAR replay** — serve recorded sessions offline
- **Hot-reload** — `--watch` reloads routes on spec file change without dropping connections
- **Reproducible output** — `--seed` locks the RNG for deterministic CI output
- **Pretty + JSON logs** — colourised terminal output or newline-delimited JSON for pipelines

---

## Installation

```bash
# Clone
git clone https://github.com/Vaibhav-gupta-tech/API_Mock_CLI.git
cd API_Mock_CLI

# Install dependencies
npm install

# Build
npm run build
```

---

## Quick Start

```bash
# Validate a spec
node dist/cli.js validate --spec ./api.json

# Start mock server — empty defaults
node dist/cli.js serve --spec ./api.json

# AI data generation with OpenRouter (Phase 2 preview)
node dist/cli.js serve --spec ./api.json --mode ai

# Random data + realistic latency
node dist/cli.js serve --spec ./api.json --mode random --latency realistic

# Reproducible random (same output every run)
node dist/cli.js serve --spec ./api.json --mode random --seed 42

# Proxy a live API + record session
node dist/cli.js serve --from https://api.example.com --record ./session.har

# Replay recorded session offline
node dist/cli.js replay --session ./session.har
```

## Environment Variables
Create a `.env` file with values like:

```env
OPENROUTER_API_KEY=sk-or-v1-YOUR-KEY-HERE
AI_CACHE_TTL=300
AI_MAX_RETRIES=3
AI_TIMEOUT=10000
```

**Note:** `AI_CACHE_TTL`, `AI_MAX_RETRIES`, and `AI_TIMEOUT` are controlled by environment variables only. CLI flags for these settings are ignored.

Then start the server normally:

```bash
node dist/cli.js serve --spec ./api.json --mode ai
```

## AI Mode

AI mode uses OpenRouter API to generate realistic mock data. Requires an API key.

### Setup

```bash
# Set your API key
echo "OPENROUTER_API_KEY=sk-or-v1-your-key-here" > .env

# Start AI mode
node dist/cli.js serve --spec ./api.json --mode ai
```

### Fallback Behavior

AI mode automatically falls back to random mode with warnings in these cases:

- **No API key**: Shows startup warning and falls back per request
- **Invalid API key**: Detects authentication failure and falls back immediately
- **Rate limits**: Detects daily limits/credits exhausted and falls back
- **Network/API errors**: Retries up to 3 times, then falls back

Debug-only helper output has been removed from this version; you will only see standard warning and response-source logs.

**Example warnings:**
```
⚠️  Warning: AI mode requested but no API key found. Will fall back to random mode.
[AI FAILURE] Invalid API key detected. Falling back to random mode.
[AI FAILURE] API limit reached. Falling back to random mode.
```

---

## Commands

### `apimock serve`

```
Options:
  --spec <path>       Path or URL to OpenAPI spec (JSON)
  --from <url>        Proxy all requests to this upstream URL
  --record <path>     Record proxied responses to a HAR file
  --mode <mode>       empty | random  (default: empty)
  --port <port>       Port to listen on  (default: 3000)
  --latency <spec>    Latency simulation (see below)
  --seed <n>          RNG seed for reproducible random output
  --include-optional  Include optional fields in responses
  --watch             Hot-reload spec on file changes
  --log-format <fmt>  pretty | json  (default: pretty)
  --quiet             Suppress per-request log lines
```

### `apimock validate`

```
Options:
  --spec <path>       Path or URL to OpenAPI spec
```

### `apimock replay`

```
Options:
  --session <path>    Path to .har session file
  --port <port>       Port to listen on  (default: 3000)
  --log-format <fmt>  pretty | json
  --quiet             Suppress per-request log lines
```

---

## Data Generation

### Empty mode (default)

Every field gets a type-correct zero value. Responses are byte-for-byte identical on every request.

| Type | Value |
|------|-------|
| `string` | `""` |
| `string` `format: date-time` | `"1970-01-01T00:00:00Z"` |
| `string` `format: uuid` | `"00000000-0000-0000-0000-000000000000"` |
| `integer` / `number` | `0` |
| `boolean` | `false` |
| `array` | One item with empty defaults |
| `enum` | First value |

### Random mode

Field names are matched against a semantic dictionary before falling back to lorem text.

| Field pattern | Example output |
|--------------|---------------|
| `email` | `ada.lovelace@example.com` |
| `first_name` | `Alice` |
| `last_name` | `Nakamura` |
| `phone`, `mobile` | `+1-555-847-2901` |
| `created_at`, `*_at` | ISO 8601 timestamp |
| `price`, `amount`, `cost` | `142.50` |
| `currency` | `USD` |
| `country` | `Germany` |
| `url`, `website` | `https://example.io/path/7` |
| `description`, `bio` | 2–4 lorem sentences |
| `status` | `active` |
| `ip`, `ip_address` | `203.0.113.42` |
| `color`, `colour` | `#3B82F6` |
| `id`, `*_id`, `uuid` | UUID v4 |

---

## Latency Simulation

All latency is additive — applied on top of actual server processing time.

| Flag | Behaviour |
|------|-----------|
| `--latency 200` | Fixed 200ms |
| `--latency 50-500` | Uniform random between 50ms and 500ms |
| `--latency p50=80,p95=300,p99=1200` | Log-normal distribution matching percentiles |
| `--latency realistic` | P50=80ms, P95=250ms (well-tuned API) |
| `--latency slow-3g` | P50=1000ms, P95=2000ms (slow mobile) |
| `--latency db-heavy` | P50=300ms, P95=1200ms (database-bound) |
| `--latency 0` | No delay |

Per-route override via spec extension:
```json
"x-apimock-latency": "db-heavy"
```

---

## Example Spec

```json
{
  "openapi": "3.0.0",
  "info": { "title": "My API", "version": "1.0.0" },
  "paths": {
    "/users": {
      "get": {
        "responses": {
          "200": {
            "content": {
              "application/json": {
                "schema": {
                  "type": "array",
                  "items": {
                    "type": "object",
                    "required": ["id", "email"],
                    "properties": {
                      "id":    { "type": "string", "format": "uuid" },
                      "email": { "type": "string", "format": "email" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

```bash
node dist/cli.js serve --spec ./api.json --mode random
# GET /users → [{"id":"a3f...","email":"ada.lovelace@example.com"}]
```

---

## Project Structure

```
src/
├── cli.ts        — Commander CLI entry point
├── server.ts     — Express HTTP server (mock + proxy)
├── parser.ts     — OpenAPI spec loading and $ref resolution
├── generator.ts  — Mock response generation from schemas
├── latency.ts    — Latency parsing and sampling
├── logger.ts     — Colourised request logging
├── proxy.ts      — Proxy forwarding, HAR record/replay
└── types.ts      — Shared TypeScript types
```

---

## Roadmap

| Phase | Status | Features |
|-------|--------|---------|
| Phase 1 | ✅ Done | Empty/random generation, latency, proxy, HAR, hot-reload |
| Phase 2 | 🔜 In progress | AI-backed response generation (OpenRouter preview), YAML spec support, chaos/error injection |
| Phase 3 | 🔜 Planned | Stateful CRUD sessions, seed data, reset endpoints |

---

## License

MIT
