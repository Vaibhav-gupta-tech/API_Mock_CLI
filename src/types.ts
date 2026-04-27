/**
 * types.ts
 * --------
 * Central type definitions shared across all modules.
 * Every major concept in apimock has a TypeScript type here so the
 * compiler catches misuse at build time rather than at runtime.
 */

import { OpenAPIV3 } from 'openapi-types';

// ─── Generation mode ─────────────────────────────────────────────────────────

/**
 * The data-generation strategy to use when building a mock response body.
 *
 *  empty  — type-correct zero values (deterministic, great for snapshot tests)
 *  random — schema-valid but varied values (supports --seed for reproducibility)
 */
export type GenerationMode = 'empty' | 'random';

// ─── Latency config ───────────────────────────────────────────────────────────

/**
 * Describes how artificial delay is added to every response.
 *
 * The latency engine always adds delay ON TOP of actual processing time,
 * so the total round-trip latency is: (processing time) + (simulated delay).
 */
export interface LatencyConfig {
  /** Minimum delay in milliseconds. */
  min: number;
  /** Maximum delay in milliseconds (same as min for fixed delays). */
  max: number;
  /**
   * When true the engine samples from a log-normal distribution fitted to the
   * p50/p95/p99 targets instead of the uniform [min, max] range.
   */
  logNormal?: boolean;
  /** Target p50 latency in ms (used only when logNormal is true). */
  p50?: number;
  /** Target p95 latency in ms (used only when logNormal is true). */
  p95?: number;
  /** Target p99 latency in ms (used only when logNormal is true). */
  p99?: number;
}

// ─── Parsed CLI options ───────────────────────────────────────────────────────

/**
 * Options produced by Commander after parsing the `apimock serve` command.
 * These drive every decision the server makes.
 */
export interface ServeOptions {
  /** Path or URL to the OpenAPI spec file. */
  spec: string;
  /** Data-generation mode. Default: 'empty'. */
  mode: GenerationMode;
  /** TCP port to listen on. Default: 3000. */
  port: number;
  /**
   * Latency descriptor string exactly as the user typed it, e.g.
   * "200", "50-500", "p50=80,p95=300,p99=1200", "realistic", "slow-3g", "0".
   */
  latency?: string;
  /** RNG seed for reproducible random output. */
  seed?: number;
  /** Include optional (non-required) fields in generated responses. */
  includeOptional: boolean;
  /** Watch the spec file and hot-reload without dropping connections. */
  watch: boolean;
  /** Output format for the request log. */
  logFormat: 'pretty' | 'json';
  /** Suppress per-request log lines. */
  quiet: boolean;
  /** Proxy all requests to this upstream URL instead of mocking. */
  from?: string;
  /** Record proxied responses to this HAR file path. */
  record?: string;
}

/**
 * Options produced by Commander after parsing the `apimock replay` command.
 */
export interface ReplayOptions {
  /** Path to the HAR session file. */
  session: string;
  /** TCP port to listen on. */
  port: number;
  /** Output format for the request log. */
  logFormat: 'pretty' | 'json';
  /** Suppress per-request log lines. */
  quiet: boolean;
}

/**
 * Options produced by Commander after parsing the `apimock validate` command.
 */
export interface ValidateOptions {
  /** Path or URL to the OpenAPI spec file. */
  spec: string;
}

// ─── Parsed & resolved spec ───────────────────────────────────────────────────

/**
 * A single route extracted from the OpenAPI spec.
 * Represents one (method, path) combination with its full operation object.
 */
export interface ParsedRoute {
  /** HTTP method in uppercase, e.g. "GET", "POST". */
  method: string;
  /** OpenAPI path pattern, e.g. "/users/{id}". */
  path: string;
  /** The full OpenAPI operation object for this route. */
  operation: OpenAPIV3.OperationObject;
  /** Per-route latency override from x-apimock-latency extension (optional). */
  latencyOverride?: string;
}

/**
 * The result of successfully loading and parsing an OpenAPI spec.
 * All $refs are resolved; allOf/oneOf/anyOf are ready for the generator.
 */
export interface ParsedSpec {
  /** The dereferenced OpenAPI document. */
  document: OpenAPIV3.Document;
  /** Flat list of every route defined in the spec. */
  routes: ParsedRoute[];
}

// ─── Response context ─────────────────────────────────────────────────────────

/**
 * Everything the generator needs to know to build one mock response.
 */
export interface ResponseContext {
  /** The matched route. */
  route: ParsedRoute;
  /** Active generation mode for this request. */
  mode: GenerationMode;
  /** RNG seed (undefined means non-deterministic). */
  seed?: number;
  /** Whether to include optional fields. */
  includeOptional: boolean;
  /** Path parameters extracted from the URL, e.g. { id: "abc123" }. */
  pathParams: Record<string, string>;
  /** Query string parameters. */
  queryParams: Record<string, string>;
}

// ─── Utility ─────────────────────────────────────────────────────────────────

/** Any JSON-serialisable value. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
