# apimock — Phase 1 Complete Documentation

A CLI tool that takes an OpenAPI spec and instantly spins up a mock HTTP server.
No config files needed. No boilerplate. Just point it at a spec and go.

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Project Structure](#project-structure)
3. [How It Works — Big Picture](#how-it-works--big-picture)
4. [File-by-File Explanation](#file-by-file-explanation)
   - [types.ts](#typests)
   - [parser.ts](#parserts)
   - [generator.ts](#generatorts)
   - [latency.ts](#latencyts)
   - [logger.ts](#loggerts)
   - [server.ts](#serverts)
   - [proxy.ts](#proxyts)
   - [cli.ts](#clits)
5. [CLI Commands Reference](#cli-commands-reference)
6. [Data Generation In Depth](#data-generation-in-depth)
7. [Latency Simulation In Depth](#latency-simulation-in-depth)
8. [Request Flow — Step by Step](#request-flow--step-by-step)
9. [Build & Run](#build--run)

---

## Quick Start

```bash
# Install dependencies
npm install

# Build (compile TypeScript → JavaScript)
npm run build

# Start mock server with an OpenAPI JSON spec
node dist/cli.js serve --spec ./api.json

# Random data, realistic latency
node dist/cli.js serve --spec ./api.json --mode random --latency realistic

# Validate a spec without starting a server
node dist/cli.js validate --spec ./api.json

# Proxy live API and record to HAR
node dist/cli.js serve --from https://api.example.com --record ./session.har

# Replay recorded session offline
node dist/cli.js replay --session ./session.har
```

---

## Project Structure

```
API_Mock_CLI/
├── src/
│   ├── types.ts       ← All shared TypeScript types (interfaces, enums)
│   ├── parser.ts      ← Load + validate + parse OpenAPI spec
│   ├── generator.ts   ← Build mock JSON responses from schemas
│   ├── latency.ts     ← Parse --latency flag, sample delay values
│   ├── logger.ts      ← Colourised request logging
│   ├── server.ts      ← Express HTTP server (mock + proxy modes)
│   ├── proxy.ts       ← Proxy forwarding, HAR record/replay
│   └── cli.ts         ← Commander CLI entry point (bin: apimock)
├── dist/              ← Compiled JS output (after npm run build)
├── package.json
└── tsconfig.json
```

---

## How It Works — Big Picture

```
User runs:  apimock serve --spec ./api.json --mode random

                    ┌─────────┐
                    │  cli.ts │  ← Parses CLI flags with Commander
                    └────┬────┘
                         │ calls startServer(opts)
                    ┌────▼────┐
                    │server.ts│  ← Creates Express app
                    └────┬────┘
                         │ reads spec via
                    ┌────▼────┐
                    │parser.ts│  ← Loads + dereferences OpenAPI spec
                    └────┬────┘
                         │ routes registered, server starts

  HTTP Request arrives
         │
  ┌──────▼──────┐
  │  server.ts  │  ← Matches request path + method against spec routes
  └──────┬──────┘
         │ matched route found
  ┌──────▼────────┐
  │ latency.ts    │  ← Waits N ms based on --latency flag
  └──────┬────────┘
         │
  ┌──────▼──────────┐
  │  generator.ts   │  ← Builds a JSON response from the route's schema
  └──────┬──────────┘
         │
  ┌──────▼──────┐
  │  logger.ts  │  ← Logs: method, path, status, mode, latency
  └──────┬──────┘
         │
  JSON response sent to client
```

---

## File-by-File Explanation

---

### types.ts

**What it is:** The single source of truth for all TypeScript types used across the project.

**Why it exists:** When multiple modules share data (e.g. the CLI passes options to the server, the server passes context to the generator), having types in one place means TypeScript can catch mismatches at compile time rather than at runtime.

**Key types defined:**

#### `GenerationMode`
```typescript
type GenerationMode = 'empty' | 'random';
```
Controls whether the generator returns zero-values or varied values. Used everywhere from the CLI all the way down to the generator.

#### `LatencyConfig`
```typescript
interface LatencyConfig {
  min: number;        // minimum delay in ms
  max: number;        // maximum delay in ms
  logNormal?: boolean; // use log-normal distribution instead of uniform
  p50?: number;       // target 50th percentile (median) in ms
  p95?: number;       // target 95th percentile in ms
  p99?: number;       // target 99th percentile in ms
}
```
What latency.ts produces from a raw string like `"realistic"` or `"50-500"`. The server uses this to decide how long to sleep before sending each response.

#### `ServeOptions`
```typescript
interface ServeOptions {
  spec: string;           // path/URL to OpenAPI spec
  mode: GenerationMode;   // empty | random
  port: number;           // e.g. 3000
  latency?: string;       // raw latency string from CLI
  seed?: number;          // RNG seed for reproducible output
  includeOptional: boolean;
  watch: boolean;
  logFormat: 'pretty' | 'json';
  quiet: boolean;
  from?: string;          // upstream URL (proxy mode)
  record?: string;        // path to write HAR file
}
```
Everything the CLI parses out of the user's command and passes to `startServer()`.

#### `ParsedRoute`
```typescript
interface ParsedRoute {
  method: string;         // "GET", "POST", etc.
  path: string;           // "/users/{id}"
  operation: OpenAPIV3.OperationObject;  // full OpenAPI operation
  latencyOverride?: string; // x-apimock-latency extension value
}
```
One route extracted from the spec. The server registers one route entry per `ParsedRoute`.

#### `ParsedSpec`
```typescript
interface ParsedSpec {
  document: OpenAPIV3.Document;  // the full dereferenced spec
  routes: ParsedRoute[];         // flat list of all routes
}
```
Return type of `loadSpec()`. The server keeps this in memory and updates it on file watch events.

#### `ReplayOptions`
```typescript
interface ReplayOptions {
  session: string;   // path to .har file
  port: number;
  logFormat: 'pretty' | 'json';
  quiet: boolean;
}
```
Options for the `apimock replay` command.

#### `JsonValue`
```typescript
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```
A recursive type that describes any value that can be serialised to JSON. The generator returns this type — it can be a string, number, object, array, or null, all the way down.

---

### parser.ts

**What it does:** Loads an OpenAPI spec file, resolves all `$ref` references, validates the document against the OpenAPI schema, and extracts a flat list of routes.

**Why SwaggerParser?** `@apidevtools/swagger-parser` is the standard OpenAPI parser for Node.js. It handles `$ref` resolution (including remote URLs like `https://...`), merges `allOf`/`oneOf`/`anyOf`, and validates the spec against the official OpenAPI meta-schema with line-number error messages.

**Key functions:**

#### `loadSpec(specPath)`
```
specPath (string) → Promise<ParsedSpec>
```
1. Calls `SwaggerParser.dereference()` — replaces every `$ref` in the document with the actual object. After this, there are no `$ref` strings left anywhere; every schema is a plain JavaScript object the generator can inspect directly.
2. Calls `SwaggerParser.validate()` — validates the spec against the OpenAPI 3.x meta-schema. Throws a detailed error with line numbers if invalid.
3. Calls `extractRoutes()` to produce the flat route list.

#### `validateSpec(specPath)`
```
specPath (string) → Promise<boolean>
```
Used by `apimock validate`. Validates without starting the server. Throws on failure so the CLI can format the error.

#### `extractRoutes(document)` (internal)
Walks the `paths` object of the OpenAPI document:
```
{
  "/users":     { get: {...}, post: {...} },
  "/users/{id}": { get: {...}, put: {...}, delete: {...} }
}
```
And flattens it into:
```
[
  { method: "GET",    path: "/users",       operation: {...} },
  { method: "POST",   path: "/users",       operation: {...} },
  { method: "GET",    path: "/users/{id}",  operation: {...} },
  ...
]
```
Also reads `x-apimock-latency` extension from each operation for per-route latency overrides.

#### `openApiPathToExpress(openApiPath)` (utility)
Converts `/users/{id}` → `/users/:id` (Express route format). Used by other modules if they need to register routes with Express directly.

---

### generator.ts

**What it does:** Given an OpenAPI schema object and a generation mode, produces a JSON value that is valid against that schema.

This is the core intelligence of the mock server.

**Two modes:**

| Mode | Behaviour |
|------|-----------|
| `empty` | Returns type-correct zero values. Always identical. Good for snapshot tests. |
| `random` | Returns varied, schema-valid values. Field names are inspected semantically. |

**Seeded RNG (mulberry32)**

```typescript
function makePrng(seed: number): () => number
```

A tiny, fast pseudo-random number generator. Why not `Math.random()`? Because `Math.random()` is non-deterministic across runs. When the user passes `--seed 42`, every call to `rand()` in the generator produces the same sequence, giving byte-for-byte identical responses on every run. This is what makes random output reproducible in CI.

`setSeed(seed?)` is called at the start of each response generation cycle. If no seed, `Math.random` is used.

**Semantic field-name inference**

In `random` mode, before falling back to generic lorem text, the generator checks the field name against a dictionary of patterns:

```typescript
const SEMANTIC_RULES: SemanticRule[] = [
  { pattern: /email/,           generate: () => "ada.lovelace@example.com" },
  { pattern: /first_?name/,     generate: () => "Alice" },
  { pattern: /phone|mobile/,    generate: () => "+1-555-847-2901" },
  { pattern: /price|amount/,    generate: () => "142.50" },
  { pattern: /colou?r/,         generate: () => "#3B82F6" },
  // ... 20+ patterns
]
```

A field named `user_email` matches `/email/` → gets a realistic email. A field named `created_at` matches `/_at$/` → gets a random ISO 8601 timestamp within the past year.

**Key function: `generateValue(schema, mode, includeOptional, fieldName, depth)`**

The main recursive dispatcher. It handles:

- **`allOf`** → merges all sub-schemas into one object (used for inheritance patterns)
- **`oneOf` / `anyOf`** → picks the first sub-schema (empty mode) or a random one (random mode)
- **`nullable`** → returns `null` in empty mode; 20% chance of `null` in random mode
- **`enum`** → returns the first value (empty) or a random value (random)
- **`object`** → recursively generates each property; skips optional fields in empty mode unless `--include-optional`
- **`array`** → generates 1 item (empty) or 2–8 items (random); respects `minItems`/`maxItems`
- **`string`** → checks format first (uuid, date-time, email, uri...), then semantic field name, then lorem fallback
- **`integer` / `number`** → `0` or `minimum` (empty), uniform random in `[minimum, maximum]` (random)
- **`boolean`** → `false` (empty), 50/50 (random)
- **depth limit** → returns `null` at depth > 10 to handle circular schema references

**Key function: `generateResponseBody(operation, mode, includeOptional, seed)`**

Finds the best response schema for a route:
1. Prefers `200`, then `201`, then `202`, then `204`, then `2XX`, then `default`
2. Falls back to the first defined response code
3. Extracts the `application/json` schema from the chosen response
4. Calls `generateValue()` and returns `{ body, statusCode }`

Special case: `204 No Content` returns `{ body: null, statusCode: 204 }` — no body is sent.

---

### latency.ts

**What it does:** Converts the raw `--latency` string the user types into a delay in milliseconds, and samples that delay for each request.

**Supported formats:**

| Input | What it means |
|-------|--------------|
| `0` | No delay |
| `200` | Fixed 200ms every request |
| `50-500` | Uniform random between 50ms and 500ms |
| `p50=80,p95=300,p99=1200` | Log-normal distribution matching those percentiles |
| `realistic` | Preset: P50=80ms, P95=250ms, P99=600ms |
| `slow-3g` | Preset: P50=1000ms, P95=2000ms, P99=4000ms |
| `db-heavy` | Preset: P50=300ms, P95=1200ms, P99=3000ms |

**Key functions:**

#### `parseLatency(raw)` → `LatencyConfig`
Parses the raw string and returns a `LatencyConfig`. Called once on startup (and per-route when `x-apimock-latency` is present). Throws a human-readable error if the format is unrecognised.

#### `sampleLatency(config)` → `number`
Called once per request. Returns a concrete millisecond value:
- **Uniform**: random integer in `[min, max]`
- **Log-normal**: samples using the Box-Muller transform

#### `sleep(ms)` → `Promise<void>`
Just `setTimeout` wrapped in a Promise. Called in the server middleware before sending the response.

**The math — why log-normal?**

Real API latencies are right-skewed: most requests are fast, but a few outliers are very slow. The log-normal distribution models this naturally.

```
μ = ln(p50)              ← because at z=0, X = exp(μ) = p50
σ = (ln(p95) - μ) / 1.6449   ← 1.6449 is the 95th percentile z-score
```

A sample `z` from Normal(0,1) via Box-Muller transform is converted to a latency sample:
```
sample = exp(μ + σ * z)
```

The result is clamped to `p99 * 2` to avoid extreme outliers.

---

### logger.ts

**What it does:** Prints colourised, formatted log lines to the terminal.

**Two output formats:**

`pretty` (default) — human-readable, colourised:
```
  GET    /users                       200  random   4ms
  POST   /users                       201  random   12ms
  GET    /users/abc123                200  random   3ms
  GET    /notfound                    404  random   1ms  ← no route match
```

`json` — machine-readable, one JSON object per line:
```json
{"ts":"2024-11-03T14:22:07Z","method":"GET","path":"/users","status":200,"mode":"random","latencyMs":4,"matched":true}
```

**Colour scheme:**
- HTTP methods: GET=green, POST=yellow, PUT=blue, PATCH=magenta, DELETE=red
- Status codes: 2xx=green, 3xx=cyan, 4xx=yellow, 5xx=red
- Latency: <300ms=green, 300–1000ms=yellow, >1000ms=red
- Mode: random=magenta, empty=blue

**Key functions:**
- `logRequest(entry, opts)` — one line per HTTP request
- `logStartup(info)` — startup banner with spec, mode, port, route count
- `logReload(specPath)` — shown when `--watch` detects a spec file change
- `logError(message, detail?)` — always shown regardless of `--quiet`
- `logInfo(message)` — general informational message

The `--quiet` flag suppresses `logRequest` calls but not startup/error messages.

---

### server.ts

**What it does:** Creates and starts the Express HTTP server. Handles both mock mode and proxy mode. Supports hot-reload via `--watch`.

**Route matching — the core challenge**

OpenAPI paths use `{param}` syntax (`/users/{id}`). Express uses `:param` syntax. Instead of translating and re-registering with Express (which would require rebuilding the app on every spec reload), the server uses a **single catch-all middleware** that does its own route matching.

Each spec route is compiled into a `RouteEntry` at startup:
```typescript
interface RouteEntry {
  route: ParsedRoute;   // the original spec route
  regex: RegExp;        // compiled match pattern
  paramNames: string[]; // param names in order, e.g. ["id"]
}
```

For `/users/{id}/posts`:
- Template is split on `{...}`: `["/users/", "id", "/posts"]`
- Literals are regex-escaped, params become `([^/]+)`
- Result: `^/users/([^/]+)/posts$`

`matchRoute(table, method, pathname)` scans the table linearly. For a typical API with dozens of routes, a linear scan is fast enough. The first route whose method and regex both match wins.

**Mock mode request flow:**
```
1. matchRoute() → find ParsedRoute for this method+path
2. If no match → 404 JSON response
3. Determine latency: per-route x-apimock-latency override OR global --latency
4. sleep(sampleLatency(config))
5. generateResponseBody() → { body, statusCode }
6. logRequest()
7. res.status(statusCode).json(body)
```

**Proxy mode request flow:**
```
1. proxyRequest(upstream, req) → forward to real API
2. If --record: recorder.record(req, result)
3. Copy response headers (skip hop-by-hop headers)
4. logRequest()
5. res.send(result.body)
```

**Watch mode:**

Uses `chokidar` to watch the spec file. When a change is detected:
```typescript
watcher.on('change', async () => {
  parsedSpec = await loadSpec(opts.spec);
  routeTable = buildRouteTable(parsedSpec.routes);
  logReload(opts.spec);
});
```

Because the middleware closes over `routeTable` by reference and the table is reassigned (not mutated), the next request automatically uses the new routes. No server restart, no dropped connections.

---

### proxy.ts

**What it does:** Three things — forward requests to an upstream API, record those exchanges to a HAR file, and replay HAR files as an offline mock server.

**HAR format** (HTTP Archive 1.2) is a JSON standard for recording HTTP sessions. It's supported by Chrome DevTools, Postman, and most API tools. By recording to HAR, sessions recorded with `apimock` can be opened and inspected in a browser.

#### `proxyRequest(upstream, req)` → `ProxyResult`

Forwards an Express `Request` to the upstream URL using `node-fetch`:
1. Strips the `host` header (would confuse the upstream server)
2. Skips body for `GET`/`HEAD`/`DELETE`
3. Re-serialises the body as JSON for other methods (since `express.json()` already parsed it)
4. Returns `{ status, headers, body: Buffer }` — the raw response

#### `createHarRecorder(outputPath)`

Returns a `recorder` object with a single `record(req, result)` method.

Each call appends a HAR entry with:
- Request: method, URL, headers, query string
- Response: status, headers, content type, body text

The file is written to disk after every entry so no data is lost if the process crashes.

HAR structure:
```json
{
  "log": {
    "version": "1.2",
    "creator": { "name": "apimock", "version": "1.0.0" },
    "entries": [
      {
        "startedDateTime": "2024-11-03T14:22:07Z",
        "request": { "method": "GET", "url": "/users", "headers": [...] },
        "response": { "status": 200, "content": { "text": "[{...}]" } }
      }
    ]
  }
}
```

#### `startReplayServer(opts)` → `Promise<void>`

Loads a HAR file and starts an Express server that returns recorded responses.

Matching logic: for each incoming request, find the first HAR entry where:
- method matches (case-insensitive)
- AND either the full URL matches OR the path (without query string) matches

This is intentionally lenient — it lets you replay a session even if the client sends slightly different query strings than what was recorded.

---

### cli.ts

**What it does:** The entry point. Reads the shebang line (`#!/usr/bin/env node`) so the compiled `dist/cli.js` can be run directly. Uses [Commander.js](https://github.com/tj/commander.js) to declare commands, flags, and validation.

**Three commands:**

#### `apimock serve`
Parses all serve-related options and calls `startServer(opts)`. Exits with code 1 on failure.

Key validations:
- `--spec` OR `--from` must be present
- `--mode` must be `empty` or `random`

#### `apimock validate`
Calls `validateSpec(specPath)`. Prints success or error. Exits with code 1 if invalid.

#### `apimock replay`
Calls `startReplayServer(opts)` with the HAR session path and port.

---

## CLI Commands Reference

### `apimock serve`

```
apimock serve [options]

Options:
  --spec <path>       Path or URL to OpenAPI spec (JSON or YAML)
  --from <url>        Proxy all requests to this upstream URL
  --record <path>     Record proxied responses to a HAR file
  --mode <mode>       empty | random  (default: empty)
  --port <port>       TCP port  (default: 3000)
  --latency <spec>    Latency simulation (see below)
  --seed <n>          RNG seed for reproducible random output
  --include-optional  Include optional (non-required) fields
  --watch             Hot-reload spec on file changes
  --log-format <fmt>  pretty | json  (default: pretty)
  --quiet             Suppress per-request log lines
```

Examples:
```bash
# Basic mock — empty defaults
apimock serve --spec ./api.json

# Random data, realistic latency
apimock serve --spec ./api.json --mode random --latency realistic

# Reproducible random (same output every run)
apimock serve --spec ./api.json --mode random --seed 42

# Include optional fields too
apimock serve --spec ./api.json --mode random --include-optional

# Fixed 200ms delay
apimock serve --spec ./api.json --latency 200

# Random 50–500ms delay
apimock serve --spec ./api.json --latency 50-500

# Log-normal distribution matching specific percentiles
apimock serve --spec ./api.json --latency "p50=80,p95=300,p99=1200"

# Watch spec file and hot-reload routes on change
apimock serve --spec ./api.json --watch

# Machine-readable JSON log (for CI pipelines)
apimock serve --spec ./api.json --log-format json

# Suppress per-request lines (startup banner still shown)
apimock serve --spec ./api.json --quiet

# Proxy live API
apimock serve --from https://api.example.com

# Proxy + record to HAR
apimock serve --from https://api.example.com --record ./session.har
```

### `apimock validate`

```bash
apimock validate --spec ./api.json
```

Validates the spec against the OpenAPI 3.x meta-schema. Reports errors with line numbers. Exits 0 on success, 1 on failure. Does not start a server.

### `apimock replay`

```bash
apimock replay --session ./session.har
apimock replay --session ./session.har --port 4000
```

Loads a recorded HAR file and serves its responses. Matching is by HTTP method and path.

---

## Data Generation In Depth

### Empty Mode

Every field gets the most predictable possible value:

| Schema type | Generated value |
|-------------|----------------|
| `string` | `""` (or `"a".repeat(minLength)` if set) |
| `string` `format: date-time` | `"1970-01-01T00:00:00Z"` |
| `string` `format: uuid` | `"00000000-0000-0000-0000-000000000000"` |
| `string` `format: email` | `"user@example.com"` |
| `integer` / `number` | `0` (or `minimum` if set) |
| `boolean` | `false` |
| `array` | One item using empty defaults recursively |
| `enum` | First value in the list |
| `nullable` | `null` |
| optional properties | Omitted (unless `--include-optional`) |

### Random Mode

Fields get varied values. The priority order for strings is:

1. **Format** (`format: uuid` → real UUID, `format: date-time` → ISO timestamp, etc.)
2. **Semantic field name** (field named `email` → realistic email, `price` → monetary value, etc.)
3. **Fallback** → lorem ipsum words, respecting `minLength`/`maxLength`

Full semantic field-name mapping:

| Field name pattern | Example output |
|-------------------|---------------|
| `email`, `user_email` | `ada.lovelace@example.com` |
| `first_name`, `given_name` | `Alice` |
| `last_name`, `surname` | `Nakamura` |
| `phone`, `mobile` | `+1-555-847-2901` |
| `avatar`, `profile_pic` | `https://i.pravatar.cc/150?u=<uuid>` |
| `created_at`, `registered_at` | `2024-03-15T08:22:07Z` |
| `updated_at`, `modified_at` | ISO timestamp within past 30 days |
| `price`, `amount`, `cost`, `total` | `142.50` |
| `currency` | `USD` |
| `country_code` | `DE` |
| `country` | `Germany` |
| `zip`, `postal_code` | `10115` |
| `city` | `Berlin` |
| `state`, `province` | `California` |
| `street`, `address` | `42 Oak Ave` |
| `url`, `website`, `link` | `https://example.io/path/7` |
| `description`, `bio`, `summary`, `body` | 2–4 lorem sentences |
| `status`, `state` | `active` |
| `ip`, `ip_address` | `203.0.113.42` |
| `color`, `colour` | `#3B82F6` |
| `uuid`, `guid` | UUID v4 |
| `id`, `user_id`, `*_id` | UUID v4 |

---

## Latency Simulation In Depth

All latency is **additive** — the simulated delay is added on top of actual server processing time.

### Uniform latency
`--latency 200` → every request waits exactly 200ms.
`--latency 50-500` → each request waits a random integer uniformly distributed in [50, 500]ms.

### Log-normal latency
`--latency realistic` or `--latency p50=80,p95=300` samples from a log-normal distribution.

**Why log-normal?** Real API latency distributions are right-skewed. Most requests complete quickly, but a small percentage hit cache misses, GC pauses, or slow DB queries and take much longer. The log-normal distribution captures this naturally.

**How it's fitted:**
```
μ = ln(p50)                              — median of the log-normal
σ = (ln(p95) - ln(p50)) / 1.6449        — spread, derived from p50 and p95
```

**How a sample is drawn:**
```
z = sample from Normal(0,1) via Box-Muller transform
sample = exp(μ + σ * z)
sample = clamp(sample, 0, p99 * 2)     — prevent extreme outliers
```

### Per-route override
Add `x-apimock-latency` to any operation in your spec:
```json
"/reports/{id}": {
  "get": {
    "x-apimock-latency": "db-heavy",
    "responses": { ... }
  }
}
```
This route uses `db-heavy` latency; all other routes use the global `--latency` setting.

---

## Request Flow — Step by Step

Here is what happens, in order, from the moment a request hits the server to the moment a response is sent:

```
1. HTTP request arrives at Express

2. express.json() middleware parses the body if Content-Type is application/json

3. Catch-all middleware runs:

   a. Record start time (for latency logging)

   b. matchRoute(routeTable, req.method, req.path)
      → Scan RouteEntry[] for a route whose regex matches req.path
         and whose method matches req.method
      → Extract path params from regex capture groups (e.g. { id: "42" })

   c. If no match:
      → logRequest(..., matched: false)
      → res.status(404).json({ error: "No matching route in spec" })
      → done

   d. Determine latency config:
      → route.latencyOverride if present
      → else global latencyConfig from --latency flag
      → else no delay (0ms)

   e. await sleep(sampleLatency(latencyCfg))
      → Sleeps for the sampled number of milliseconds
      → This is the simulated artificial delay

   f. generateResponseBody(operation, mode, includeOptional, seed)
      → Finds the best response definition in the spec (200 → 201 → first)
      → Extracts the application/json schema
      → Recursively generates a value matching the schema
      → Returns { body: JsonValue, statusCode: number }

   g. latencyMs = Date.now() - startTime
      → This is the TOTAL wall-clock time including the sleep

   h. logRequest({ method, path, status, mode, latencyMs, matched: true }, opts)
      → Prints one log line

   i. if body is null (204 No Content):
      → res.status(204).send()
      else:
      → res.status(statusCode).json(body)
```

---

## Build & Run

```bash
# Install all dependencies listed in package.json
npm install

# Compile TypeScript → JavaScript (output in ./dist/)
npm run build

# Run directly with ts-node (no build needed, slower startup)
npm run dev -- serve --spec ./api.json

# Run compiled build
node dist/cli.js serve --spec ./api.json

# If installed globally (npm install -g .)
apimock serve --spec ./api.json

# Or without global install (uses package.json bin field)
npx apimock serve --spec ./api.json
```

**Dependency overview:**

| Package | Why |
|---------|-----|
| `commander` | CLI argument parsing — commands, options, help text |
| `express` | HTTP server framework |
| `@apidevtools/swagger-parser` | OpenAPI spec loading, `$ref` resolution, validation |
| `openapi-types` | TypeScript types for OpenAPI 3.x documents |
| `uuid` | Generating UUID v4 values in random mode |
| `chalk` | Terminal colours for the pretty log format |
| `chokidar` | File watching for `--watch` hot-reload |
| `node-fetch` | HTTP client for proxy mode |
| `yaml` | (Reserved for Phase 2 YAML spec support) |
| `morgan` | (Available, not used — custom logger used instead) |
