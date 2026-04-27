/**
 * generator.ts
 * ------------
 * The heart of apimock: given an OpenAPI schema and a generation mode,
 * produce a realistic JSON value that is valid against that schema.
 *
 * TWO MODES
 * ─────────
 * Mode A — "empty"
 *   Every field gets a type-correct zero value.  Responses are byte-for-byte
 *   identical on every request.  Perfect for snapshot tests and CI.
 *
 * Mode B — "random"
 *   Fields get varied, schema-valid values.  Field *names* are inspected via a
 *   semantic dictionary so an "email" field gets an email address, a "price"
 *   field gets a monetary amount, etc.  --seed makes the sequence deterministic.
 *
 * DESIGN NOTES
 * ────────────
 * • We never import the full spec here — only the individual schema object for
 *   the response being generated.  The parser has already dereferenced all $refs.
 * • allOf/oneOf/anyOf are handled by merging/picking schemas before recursing.
 * • Circular references are broken by a depth limit (MAX_DEPTH).
 */

import { v4 as uuidv4 } from 'uuid';
import { OpenAPIV3 } from 'openapi-types';
import { GenerationMode, JsonValue } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum recursion depth to prevent infinite loops on circular schemas. */
const MAX_DEPTH = 10;

// ─── Simple seeded PRNG (mulberry32) ─────────────────────────────────────────
/**
 * mulberry32 — a tiny, fast, seedable pseudo-random number generator.
 * Returns a function that yields a float in [0, 1) on each call.
 *
 * We use this instead of Math.random() so that --seed <n> produces
 * byte-for-byte identical output across runs.
 */
function makePrng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Module-level PRNG instance; replaced when --seed is provided.
let _rand: () => number = Math.random.bind(Math);

/**
 * Call this once per request (or once on startup) to set the RNG seed.
 * If seed is undefined, Math.random() is used (non-deterministic).
 */
export function setSeed(seed?: number): void {
  _rand = seed !== undefined ? makePrng(seed) : Math.random.bind(Math);
}

/** Return a float in [0, 1). */
function rand(): number {
  return _rand();
}

/** Return an integer in [min, max] inclusive. */
function randInt(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min;
}

/** Pick a random element from an array. */
function pick<T>(arr: T[]): T {
  return arr[Math.floor(rand() * arr.length)];
}

// ─── Semantic field-name dictionary ──────────────────────────────────────────
/**
 * Maps field-name patterns (lowercased) to generator functions.
 * The generator is consulted only in "random" mode and only for string fields.
 *
 * Order matters: more specific patterns should come before broader ones.
 * The first pattern whose RegExp matches the field name wins.
 */
interface SemanticRule {
  pattern: RegExp;
  generate: () => string;
}

const SEMANTIC_RULES: SemanticRule[] = [
  // ── Identity / auth ──────────────────────────────────────────────────────
  {
    pattern: /^(user_?id|account_?id|customer_?id|.*_?id)$/,
    generate: () => uuidv4(),
  },
  // ── Email ────────────────────────────────────────────────────────────────
  {
    pattern: /email/,
    generate: () => {
      const first = pick(['ada', 'alan', 'grace', 'linus', 'margaret', 'tim', 'james', 'sofia']);
      const last = pick(['lovelace', 'turing', 'hopper', 'torvalds', 'hamilton', 'berners-lee']);
      return `${first}.${last}@example.com`;
    },
  },
  // ── Name ─────────────────────────────────────────────────────────────────
  {
    pattern: /first_?name|given_?name|forename/,
    generate: () => pick(['Alice', 'Bob', 'Carlos', 'Diana', 'Eve', 'Frank', 'Grace', 'Hiro', 'Ingrid', 'James']),
  },
  {
    pattern: /last_?name|surname|family_?name/,
    generate: () => pick(['Smith', 'Delacroix', 'Nakamura', 'García', 'Okonkwo', 'Patel', 'Müller', 'Kim']),
  },
  {
    pattern: /\bname\b/,
    generate: () => pick(['Alice Smith', 'Bob Jones', 'Carlos García', 'Diana Patel']),
  },
  // ── Phone ────────────────────────────────────────────────────────────────
  {
    pattern: /phone|mobile|cell/,
    generate: () => `+1-555-${randInt(100, 999)}-${randInt(1000, 9999)}`,
  },
  // ── Avatar / image ───────────────────────────────────────────────────────
  {
    pattern: /avatar|profile_?pic|photo/,
    generate: () => `https://i.pravatar.cc/150?u=${uuidv4()}`,
  },
  // ── Timestamps ───────────────────────────────────────────────────────────
  {
    pattern: /created_?at|registered_?at|joined_?at/,
    generate: () => randomPastDate(730),  // up to 2 years ago
  },
  {
    pattern: /updated_?at|modified_?at|changed_?at/,
    generate: () => randomPastDate(30),   // up to 30 days ago
  },
  {
    pattern: /_at$|timestamp/,
    generate: () => randomPastDate(365),
  },
  // ── Price / money ─────────────────────────────────────────────────────────
  {
    pattern: /price|amount|cost|total|subtotal|revenue|salary/,
    generate: () => (rand() * 999 + 1).toFixed(2),
  },
  {
    pattern: /currency/,
    generate: () => pick(['USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'CHF', 'INR', 'BRL']),
  },
  // ── Geographic ───────────────────────────────────────────────────────────
  {
    pattern: /country_?code/,
    generate: () => pick(['US', 'DE', 'FR', 'GB', 'JP', 'IN', 'BR', 'CA', 'AU', 'MX']),
  },
  {
    pattern: /country/,
    generate: () => pick(['United States', 'Germany', 'France', 'United Kingdom', 'Japan', 'India']),
  },
  {
    pattern: /zip|postal_?code|postcode/,
    generate: () => String(randInt(10000, 99999)),
  },
  {
    pattern: /city/,
    generate: () => pick(['New York', 'Berlin', 'Paris', 'London', 'Tokyo', 'Mumbai', 'São Paulo']),
  },
  {
    pattern: /state|province|region/,
    generate: () => pick(['California', 'Bavaria', 'Île-de-France', 'Ontario', 'Maharashtra']),
  },
  {
    pattern: /street|^address$/,
    generate: () => `${randInt(1, 999)} ${pick(['Main St', 'Oak Ave', 'Maple Rd', 'Park Blvd', 'High St'])}`,
  },
  // ── URL / web ─────────────────────────────────────────────────────────────
  {
    pattern: /url|website|link|href/,
    generate: () => `https://${pick(['plausible', 'example', 'mockapi', 'testsite'])}.${pick(['io', 'com', 'dev'])}/path/${randInt(1, 999)}`,
  },
  // ── Text / description ────────────────────────────────────────────────────
  {
    pattern: /description|bio|summary|body|content|text|note|comment/,
    generate: () => loremSentences(randInt(2, 4)),
  },
  // ── Status ────────────────────────────────────────────────────────────────
  {
    pattern: /status|state/,
    generate: () => pick(['active', 'inactive', 'pending', 'archived', 'draft']),
  },
  // ── Networking (must come before generic "address" rule) ──────────────────
  {
    pattern: /ip_?address|ip/,
    generate: () => `${randInt(1, 254)}.${randInt(0, 255)}.${randInt(0, 255)}.${randInt(1, 254)}`,
  },
  // ── Color ────────────────────────────────────────────────────────────────
  {
    pattern: /colou?r/,
    generate: () => `#${Math.floor(rand() * 0xffffff).toString(16).padStart(6, '0').toUpperCase()}`,
  },
  // ── UUID (explicit) ───────────────────────────────────────────────────────
  {
    pattern: /uuid|guid/,
    generate: () => uuidv4(),
  },
];

/** Lookup table for O(n) linear scan — fine for typical schema field counts. */
function semanticValue(fieldName: string): string | null {
  const lower = fieldName.toLowerCase();
  for (const rule of SEMANTIC_RULES) {
    if (rule.pattern.test(lower)) {
      return rule.generate();
    }
  }
  return null;
}

// ─── Lorem ipsum helpers ─────────────────────────────────────────────────────

const LOREM_WORDS = [
  'lorem', 'ipsum', 'dolor', 'sit', 'amet', 'consectetur', 'adipiscing', 'elit',
  'sed', 'do', 'eiusmod', 'tempor', 'incididunt', 'ut', 'labore', 'et', 'dolore',
  'magna', 'aliqua', 'enim', 'ad', 'minim', 'veniam', 'quis', 'nostrud',
  'exercitation', 'ullamco', 'laboris', 'nisi', 'aliquip', 'ex', 'ea', 'commodo',
  'consequat', 'duis', 'aute', 'irure', 'reprehenderit', 'voluptate', 'velit',
  'esse', 'cillum', 'fugiat', 'nulla', 'pariatur', 'excepteur', 'sint', 'occaecat',
  'cupidatat', 'non', 'proident', 'sunt', 'culpa', 'qui', 'officia', 'deserunt',
  'mollit', 'anim', 'id', 'est', 'laborum',
];

function loremWords(n: number): string {
  return Array.from({ length: n }, () => pick(LOREM_WORDS)).join(' ');
}

function loremSentences(n: number): string {
  return Array.from({ length: n }, () => {
    const words = loremWords(randInt(8, 14));
    return words.charAt(0).toUpperCase() + words.slice(1) + '.';
  }).join(' ');
}

/** Generate a random ISO 8601 date-time within the past `maxDays` days. */
function randomPastDate(maxDays: number): string {
  const msAgo = rand() * maxDays * 24 * 60 * 60 * 1000;
  return new Date(Date.now() - msAgo).toISOString();
}

// ─── Core generator ───────────────────────────────────────────────────────────

/**
 * Generate a mock value for a single OpenAPI schema.
 *
 * @param schema          The (already-dereferenced) schema object.
 * @param mode            "empty" or "random".
 * @param includeOptional When true, optional properties are included.
 * @param fieldName       The property name in the parent object (for semantic inference).
 * @param depth           Current recursion depth — stops at MAX_DEPTH.
 */
export function generateValue(
  schema: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
  mode: GenerationMode,
  includeOptional: boolean,
  fieldName = '',
  depth = 0,
): JsonValue {
  // Safety: stop recursion if we're too deep (handles circular schemas)
  if (depth > MAX_DEPTH) return null;

  // After SwaggerParser.dereference() there should be no $ref strings left,
  // but TypeScript doesn't know that — we cast to narrow the type.
  const s = schema as OpenAPIV3.SchemaObject;

  // ── Composition keywords ─────────────────────────────────────────────────
  // allOf: merge all sub-schemas into one combined object schema
  if (s.allOf && s.allOf.length > 0) {
    return generateAllOf(s.allOf as OpenAPIV3.SchemaObject[], mode, includeOptional, depth);
  }

  // oneOf / anyOf: pick one sub-schema to generate from
  if (s.oneOf && s.oneOf.length > 0) {
    const chosen = mode === 'random' ? pick(s.oneOf as OpenAPIV3.SchemaObject[]) : s.oneOf[0] as OpenAPIV3.SchemaObject;
    return generateValue(chosen, mode, includeOptional, fieldName, depth);
  }
  if (s.anyOf && s.anyOf.length > 0) {
    const chosen = mode === 'random' ? pick(s.anyOf as OpenAPIV3.SchemaObject[]) : s.anyOf[0] as OpenAPIV3.SchemaObject;
    return generateValue(chosen, mode, includeOptional, fieldName, depth);
  }

  // ── nullable ─────────────────────────────────────────────────────────────
  // OpenAPI 3.0: { nullable: true }  means the value CAN be null.
  // In empty mode we always return null for nullable fields.
  if (s.nullable && mode === 'empty') return null;
  // In random mode, 20% chance of null for nullable fields
  if (s.nullable && mode === 'random' && rand() < 0.2) return null;

  // ── enum ─────────────────────────────────────────────────────────────────
  if (s.enum && s.enum.length > 0) {
    return mode === 'random'
      ? (pick(s.enum) as JsonValue)
      : (s.enum[0] as JsonValue);
  }

  // ── Dispatch by type ─────────────────────────────────────────────────────
  switch (s.type) {
    case 'object':
      return generateObject(s, mode, includeOptional, depth);

    case 'array':
      return generateArray(s, mode, includeOptional, depth);

    case 'string':
      return generateString(s, mode, fieldName);

    case 'integer':
    case 'number':
      return generateNumber(s, mode);

    case 'boolean':
      return mode === 'random' ? rand() < 0.5 : false;

    default:
      // No type specified — try to infer from properties (treat as object)
      if (s.properties) {
        return generateObject(s, mode, includeOptional, depth);
      }
      // Truly unknown — return null rather than crashing
      return null;
  }
}

// ─── Per-type generators ─────────────────────────────────────────────────────

function generateObject(
  schema: OpenAPIV3.SchemaObject,
  mode: GenerationMode,
  includeOptional: boolean,
  depth: number,
): JsonValue {
  const result: Record<string, JsonValue> = {};
  const required = new Set(schema.required ?? []);

  if (!schema.properties) return result;

  for (const [propName, propSchema] of Object.entries(schema.properties)) {
    // Skip optional properties unless --include-optional is set or mode is random
    const isRequired = required.has(propName);
    if (!isRequired && !includeOptional && mode === 'empty') continue;
    // In random mode optionally skip ~30% of optional fields for variety
    if (!isRequired && !includeOptional && mode === 'random' && rand() < 0.3) continue;

    result[propName] = generateValue(
      propSchema,
      mode,
      includeOptional,
      propName,
      depth + 1,
    );
  }

  return result;
}

function generateArray(
  schema: OpenAPIV3.SchemaObject,
  mode: GenerationMode,
  includeOptional: boolean,
  depth: number,
): JsonValue {
  const minItems = schema.minItems ?? (mode === 'empty' ? 1 : 2);
  const maxItems = schema.maxItems ?? (mode === 'empty' ? 1 : 8);
  const count = mode === 'random' ? randInt(minItems, maxItems) : minItems;

  const itemSchema = (schema as OpenAPIV3.ArraySchemaObject).items as OpenAPIV3.SchemaObject | undefined;
  if (!itemSchema) return [];

  return Array.from({ length: count }, () =>
    generateValue(itemSchema, mode, includeOptional, '', depth + 1),
  );
}

function generateString(
  schema: OpenAPIV3.SchemaObject,
  mode: GenerationMode,
  fieldName: string,
): string {
  // ── empty mode ────────────────────────────────────────────────────────────
  if (mode === 'empty') {
    // Handle special string formats
    switch (schema.format) {
      case 'date-time': return '1970-01-01T00:00:00Z';
      case 'date':      return '1970-01-01';
      case 'time':      return '00:00:00';
      case 'uuid':      return '00000000-0000-0000-0000-000000000000';
      case 'email':     return 'user@example.com';
      case 'uri':
      case 'url':       return 'https://example.com';
      case 'ipv4':      return '0.0.0.0';
      case 'ipv6':      return '::';
      case 'binary':
      case 'byte':      return '';
    }
    // minLength → repeat 'a' that many times
    const min = schema.minLength ?? 0;
    return 'a'.repeat(min);
  }

  // ── random mode ───────────────────────────────────────────────────────────
  // 1. Format-specific generators take priority
  switch (schema.format) {
    case 'date-time': return randomPastDate(365 * 2);
    case 'date':      return randomPastDate(365 * 2).split('T')[0];
    case 'time':      return `${String(randInt(0, 23)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}:${String(randInt(0, 59)).padStart(2, '0')}`;
    case 'uuid':      return uuidv4();
    case 'email':     return (SEMANTIC_RULES.find(r => r.pattern.test('email'))?.generate() ?? 'user@example.com');
    case 'uri':
    case 'url':       return `https://example.com/${loremWords(1)}`;
    case 'ipv4':      return `${randInt(1,254)}.${randInt(0,255)}.${randInt(0,255)}.${randInt(1,254)}`;
    case 'ipv6':      return '2001:db8::' + randInt(1, 9999).toString(16);
    case 'binary':
    case 'byte':      return Buffer.from(loremWords(3)).toString('base64');
    case 'password':  return 'P@ssw0rd!' + randInt(100, 999);
  }

  // 2. Try semantic field-name inference
  if (fieldName) {
    const semantic = semanticValue(fieldName);
    if (semantic !== null) return semantic;
  }

  // 3. Fallback: lorem words, respecting minLength / maxLength
  const min = schema.minLength ?? 3;
  const max = schema.maxLength ?? 40;
  const wordCount = Math.max(1, Math.round((min + max) / 2 / 5));
  const result = loremWords(wordCount);
  // Ensure it fits within min/max
  if (result.length < min) return result + 'a'.repeat(min - result.length);
  if (result.length > max) return result.slice(0, max);
  return result;
}

function generateNumber(
  schema: OpenAPIV3.SchemaObject,
  mode: GenerationMode,
): number {
  if (mode === 'empty') {
    return schema.minimum ?? 0;
  }

  const min = schema.minimum ?? 0;
  const max = schema.maximum ?? (schema.type === 'integer' ? 1000 : 1.0);

  if (schema.type === 'integer') {
    return randInt(Math.ceil(min), Math.floor(max));
  }

  // float: random in [min, max] with 4 decimal places
  return parseFloat((rand() * (max - min) + min).toFixed(4));
}

/**
 * Generate a value that satisfies allOf by merging all sub-schema objects.
 * This works well for the common case where allOf is used for inheritance /
 * mixin patterns. Non-object allOf members are handled gracefully.
 */
function generateAllOf(
  schemas: OpenAPIV3.SchemaObject[],
  mode: GenerationMode,
  includeOptional: boolean,
  depth: number,
): JsonValue {
  const merged: Record<string, JsonValue> = {};

  for (const sub of schemas) {
    const val = generateValue(sub, mode, includeOptional, '', depth + 1);
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      Object.assign(merged, val);
    }
  }

  return merged;
}

// ─── Response body builder ────────────────────────────────────────────────────

/**
 * Find the best response schema for a route and generate a mock body.
 *
 * Strategy:
 *   1. Look for a 200 or 201 response (success).
 *   2. Fall back to the first defined response.
 *   3. If no schema is found, return an empty object {}.
 *
 * @returns { body, statusCode } — the generated body and the HTTP status code.
 */
export function generateResponseBody(
  operation: import('openapi-types').OpenAPIV3.OperationObject,
  mode: GenerationMode,
  includeOptional: boolean,
  seed?: number,
): { body: JsonValue; statusCode: number } {
  // Set the seed for this generation pass
  setSeed(seed);

  const responses = operation.responses as Record<string, OpenAPIV3.ResponseObject>;
  if (!responses) return { body: {}, statusCode: 200 };

  // Preference order for picking the response definition
  const PREFERRED_CODES = ['200', '201', '202', '204', '2XX', 'default'];
  let chosenCode = '200';
  let chosenResponse: OpenAPIV3.ResponseObject | null = null;

  for (const code of PREFERRED_CODES) {
    if (responses[code]) {
      chosenCode = code === '2XX' || code === 'default' ? '200' : code;
      chosenResponse = responses[code] as OpenAPIV3.ResponseObject;
      break;
    }
  }

  // If still nothing, take the first defined response
  if (!chosenResponse) {
    const [code, resp] = Object.entries(responses)[0] ?? [];
    chosenCode = code ?? '200';
    chosenResponse = resp as OpenAPIV3.ResponseObject;
  }

  const statusCode = parseInt(chosenCode, 10) || 200;

  // 204 No Content — no body
  if (statusCode === 204) return { body: null, statusCode };

  // Extract the JSON schema from the response's content
  const content = chosenResponse?.content;
  const jsonContent = content?.['application/json'] ?? content?.['*/*'];
  const schema = jsonContent?.schema as OpenAPIV3.SchemaObject | undefined;

  if (!schema) return { body: {}, statusCode };

  const body = generateValue(schema, mode, includeOptional, '', 0);
  return { body, statusCode };
}
