#!/usr/bin/env node

import { Command } from 'commander';
import { startServer } from './server';
import { validateSpec } from './parser';
import { startReplayServer } from './proxy';
import { logError } from './logger';

const program = new Command();

program
  .name('apimock')
  .description('Instant API mock server from an OpenAPI spec')
  .version('1.0.0');

// ─── serve ────────────────────────────────────────────────────────────────────

program
  .command('serve')
  .description('Start a mock HTTP server from an OpenAPI spec')
  .option('--spec <path>', 'Path or URL to OpenAPI spec')
  .option('--from <url>', 'Proxy all requests to this upstream URL')
  .option('--record <path>', 'Record proxied responses to a HAR file')
  .option('--mode <mode>', 'Response generation: empty | random', 'empty')
  .option('--port <port>', 'Port to listen on', '3000')
  .option('--latency <spec>', 'Latency: 200 | 50-500 | p50=80,p95=300 | realistic | slow-3g | db-heavy')
  .option('--seed <n>', 'RNG seed for reproducible random output')
  .option('--include-optional', 'Include optional fields in responses', false)
  .option('--watch', 'Hot-reload spec file on changes', false)
  .option('--log-format <fmt>', 'Log output: pretty | json', 'pretty')
  .option('--quiet', 'Suppress per-request log lines', false)
  .action(async (opts) => {
    if (!opts.spec && !opts.from) {
      logError('--spec or --from is required');
      process.exit(1);
    }
    if (opts.mode && !['empty', 'random'].includes(opts.mode)) {
      logError(`Invalid --mode "${opts.mode}". Must be empty or random.`);
      process.exit(1);
    }

    try {
      await startServer({
        spec: opts.spec ?? '',
        from: opts.from,
        record: opts.record,
        mode: opts.mode as 'empty' | 'random',
        port: parseInt(opts.port, 10),
        latency: opts.latency,
        seed: opts.seed !== undefined ? parseInt(opts.seed, 10) : undefined,
        includeOptional: opts.includeOptional as boolean,
        watch: opts.watch as boolean,
        logFormat: opts.logFormat as 'pretty' | 'json',
        quiet: opts.quiet as boolean,
      });
    } catch (err) {
      logError('Failed to start server', String(err));
      process.exit(1);
    }
  });

// ─── validate ─────────────────────────────────────────────────────────────────

program
  .command('validate')
  .description('Validate an OpenAPI spec without starting a server')
  .requiredOption('--spec <path>', 'Path or URL to OpenAPI spec')
  .action(async (opts) => {
    try {
      await validateSpec(opts.spec);
      console.log(`\n  ✓  ${opts.spec} is a valid OpenAPI spec\n`);
    } catch (err) {
      logError('Spec validation failed', String(err));
      process.exit(1);
    }
  });

// ─── replay ───────────────────────────────────────────────────────────────────

program
  .command('replay')
  .description('Serve recorded responses from a HAR session file')
  .requiredOption('--session <path>', 'Path to .har session file')
  .option('--port <port>', 'Port to listen on', '3000')
  .option('--log-format <fmt>', 'Log output: pretty | json', 'pretty')
  .option('--quiet', 'Suppress per-request log lines', false)
  .action(async (opts) => {
    try {
      await startReplayServer({
        session: opts.session,
        port: parseInt(opts.port, 10),
        logFormat: opts.logFormat as 'pretty' | 'json',
        quiet: opts.quiet as boolean,
      });
    } catch (err) {
      logError('Failed to start replay server', String(err));
      process.exit(1);
    }
  });

program.parse(process.argv);
