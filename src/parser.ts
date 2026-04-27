/**
 * parser.ts
 * ---------
 * Loads and validates an OpenAPI spec file (JSON or YAML), resolves all $ref
 * references (local file + remote HTTP), and extracts a flat list of routes.
 *
 * WHY SwaggerParser?
 *   @apidevtools/swagger-parser is the gold-standard OpenAPI parser for Node.js.
 *   It handles:
 *     • JSON and YAML auto-detection
 *     • Recursive $ref resolution (including remote URLs)
 *     • allOf / oneOf / anyOf merging (via dereference())
 *     • Schema validation against the OpenAPI 3.x meta-schema
 *
 * The module exposes two public functions:
 *   loadSpec(path)     – full load + validate + route extraction
 *   validateSpec(path) – validate only, no server started
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import { OpenAPIV3 } from 'openapi-types';
import { ParsedSpec, ParsedRoute } from './types';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Load, validate, dereference and parse an OpenAPI 3.x spec.
 *
 * @param specPath  Absolute/relative file path or HTTP(S) URL to the spec.
 * @returns         Fully resolved ParsedSpec ready for the mock server.
 * @throws          Descriptive error with line numbers when the spec is invalid.
 */
export async function loadSpec(specPath: string): Promise<ParsedSpec> {
  // Step 1: Dereference replaces every $ref with the actual object in-place.
  // After this call there are NO $ref strings anywhere in the document — every
  // schema is a plain JS object that the generator can inspect directly.
  const document = (await SwaggerParser.dereference(specPath)) as OpenAPIV3.Document;

  // Step 2: Validate the dereferenced document against the OpenAPI 3.x spec.
  // SwaggerParser.validate() throws a detailed error with line numbers when
  // the spec violates the schema (e.g. missing "paths", wrong type values).
  await SwaggerParser.validate(specPath);

  // Step 3: Extract a flat array of routes from the paths object.
  const routes = extractRoutes(document);

  return { document, routes };
}

/**
 * Validate a spec file and print any errors.
 * Used by `apimock validate --spec ./api.json`.
 *
 * @param specPath  Path or URL to the spec.
 * @returns         true if valid, false if invalid.
 */
export async function validateSpec(specPath: string): Promise<boolean> {
  try {
    await SwaggerParser.validate(specPath);
    return true;
  } catch (err) {
    throw err; // Let the CLI layer format the error
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Walk the OpenAPI `paths` object and produce one ParsedRoute per
 * (HTTP method, path) combination.
 *
 * OpenAPI paths look like:
 *   {
 *     "/users": { get: { ... }, post: { ... } },
 *     "/users/{id}": { get: { ... }, put: { ... }, delete: { ... } }
 *   }
 *
 * We flatten this into:
 *   [
 *     { method: "GET",    path: "/users",      operation: { ... } },
 *     { method: "POST",   path: "/users",      operation: { ... } },
 *     { method: "GET",    path: "/users/{id}", operation: { ... } },
 *     ...
 *   ]
 */
function extractRoutes(document: OpenAPIV3.Document): ParsedRoute[] {
  const routes: ParsedRoute[] = [];

  // HTTP methods defined by the OpenAPI spec (excludes "parameters", "servers", etc.)
  const HTTP_METHODS = [
    'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace',
  ] as OpenAPIV3.HttpMethods[];

  if (!document.paths) {
    return routes;
  }

  for (const [path, pathItem] of Object.entries(document.paths)) {
    if (!pathItem) continue;

    for (const method of HTTP_METHODS) {
      const operation = pathItem[method] as OpenAPIV3.OperationObject | undefined;
      if (!operation) continue;

      // Pull out any per-route latency override stored as an OpenAPI extension.
      // Spec authors can add:  x-apimock-latency: "p50=100,p95=500"
      const extensions = operation as Record<string, unknown>;
      const latencyOverride = extensions['x-apimock-latency'] as string | undefined;

      routes.push({
        method: method.toUpperCase(),
        path,
        operation,
        latencyOverride,
      });
    }
  }

  return routes;
}

/**
 * Convert an OpenAPI path pattern to an Express route pattern.
 *
 * OpenAPI uses  /users/{id}
 * Express uses  /users/:id
 *
 * This is a simple regex replacement — it handles all standard path templates.
 */
export function openApiPathToExpress(openApiPath: string): string {
  // Replace every {paramName} with :paramName
  return openApiPath.replace(/\{([^}]+)\}/g, ':$1');
}
