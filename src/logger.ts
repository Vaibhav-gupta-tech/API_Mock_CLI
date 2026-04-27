/**
 * logger.ts
 * ---------
 * Colourised request logging for the mock server.
 *
 * Two output modes controlled by --log-format:
 *
 *  "pretty" (default)
 *    Colourised, human-readable single-line per request.
 *    Example:
 *      → GET  /users/42          200  random   47ms
 *
 *  "json"
 *    Newline-delimited JSON for machine consumption (CI pipelines, log aggregators).
 *    Example:
 *      {"ts":"2024-11-03T14:22:07Z","method":"GET","path":"/users/42","status":200,...}
 *
 * DESIGN: chalk v4 is used for colours because it works in CommonJS without
 * dynamic imports.  We pin to v4.x in package.json for this reason.
 */

import chalk from 'chalk';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RequestLogEntry {
  method:    string;   // "GET"
  path:      string;   // "/users/42"
  status:    number;   // 200
  mode:      string;   // "random" | "empty"
  latencyMs: number;   // wall-clock time in ms
  matched:   boolean;  // whether the route was found in the spec
}

export interface LoggerOptions {
  format: 'pretty' | 'json';
  quiet:  boolean;             // suppress per-request lines
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Print a single request log line according to the configured format.
 * Does nothing if `quiet` is true.
 */
export function logRequest(entry: RequestLogEntry, opts: LoggerOptions): void {
  if (opts.quiet) return;
  if (opts.format === 'json') {
    logJson(entry);
  } else {
    logPretty(entry);
  }
}

/**
 * Print the server startup banner.
 * Always shown regardless of --quiet.
 */
export function logStartup(info: {
  port:    number;
  spec:    string;
  mode:    string;
  latency: string | undefined;
  routes:  number;
  watch:   boolean;
}): void {
  console.log('');
  console.log(chalk.bold.cyan('  ╔══════════════════════════════════════╗'));
  console.log(chalk.bold.cyan('  ║') + chalk.bold.white('       apimock  — API Mock Server      ') + chalk.bold.cyan('║'));
  console.log(chalk.bold.cyan('  ╚══════════════════════════════════════╝'));
  console.log('');
  console.log(`  ${chalk.dim('Spec  ')}  ${chalk.white(info.spec)}`);
  console.log(`  ${chalk.dim('Mode  ')}  ${modeColour(info.mode)}`);
  console.log(`  ${chalk.dim('Latency')} ${info.latency ? chalk.yellow(info.latency) : chalk.dim('none')}`);
  console.log(`  ${chalk.dim('Routes')}  ${chalk.white(String(info.routes))} endpoints registered`);
  console.log(`  ${chalk.dim('Watch ')}  ${info.watch ? chalk.green('enabled') : chalk.dim('disabled')}`);
  console.log('');
  console.log(`  ${chalk.bold.green('✓')} Listening on ${chalk.bold.underline.cyan(`http://localhost:${info.port}`)}`);
  console.log('');
  console.log(`  ${chalk.dim('─────────────────────────────────────────')}`);
  console.log(`  ${chalk.dim('method  path                 status  mode  latency')}`);
  console.log(`  ${chalk.dim('─────────────────────────────────────────')}`);
}

/**
 * Print a reload notice (used when --watch detects a spec change).
 */
export function logReload(specPath: string): void {
  console.log(`\n  ${chalk.bold.yellow('↺')}  Spec changed — reloading routes from ${chalk.white(specPath)}\n`);
}

/**
 * Print a formatted error message.  Always shown regardless of --quiet.
 */
export function logError(message: string, detail?: string): void {
  console.error(`\n  ${chalk.bold.red('✗')}  ${chalk.red(message)}`);
  if (detail) console.error(`     ${chalk.dim(detail)}`);
  console.error('');
}

/**
 * Print a general info message.
 */
export function logInfo(message: string): void {
  console.log(`  ${chalk.bold.blue('ℹ')}  ${message}`);
}

// ─── Internal formatters ─────────────────────────────────────────────────────

function logPretty(e: RequestLogEntry): void {
  const method  = methodColour(e.method).padEnd(14);   // "GET  " in colour
  const path    = chalk.white(e.path.padEnd(28));
  const status  = statusColour(e.status);
  const mode    = chalk.dim(e.mode.padEnd(8));
  const latency = latencyColour(e.latencyMs);
  const warn    = e.matched ? '' : chalk.red('  ← no route match');

  console.log(`  ${method} ${path} ${status}  ${mode} ${latency}${warn}`);
}

function logJson(e: RequestLogEntry): void {
  const obj = {
    ts:        new Date().toISOString(),
    method:    e.method,
    path:      e.path,
    status:    e.status,
    mode:      e.mode,
    latencyMs: e.latencyMs,
    matched:   e.matched,
  };
  console.log(JSON.stringify(obj));
}

// ─── Colour helpers ───────────────────────────────────────────────────────────

function methodColour(method: string): string {
  switch (method.toUpperCase()) {
    case 'GET':    return chalk.bold.green(method.padEnd(6));
    case 'POST':   return chalk.bold.yellow(method.padEnd(6));
    case 'PUT':    return chalk.bold.blue(method.padEnd(6));
    case 'PATCH':  return chalk.bold.magenta(method.padEnd(6));
    case 'DELETE': return chalk.bold.red(method.padEnd(6));
    default:       return chalk.bold.white(method.padEnd(6));
  }
}

function statusColour(status: number): string {
  const s = String(status);
  if (status >= 500) return chalk.bold.red(s);
  if (status >= 400) return chalk.bold.yellow(s);
  if (status >= 300) return chalk.bold.cyan(s);
  return chalk.bold.green(s);
}

function modeColour(mode: string): string {
  switch (mode) {
    case 'random': return chalk.bold.magenta('random');
    case 'empty':  return chalk.bold.blue('empty');
    default:       return chalk.white(mode);
  }
}

function latencyColour(ms: number): string {
  const label = `${ms}ms`;
  if (ms > 1000) return chalk.red(label);
  if (ms > 300)  return chalk.yellow(label);
  return chalk.green(label);
}
