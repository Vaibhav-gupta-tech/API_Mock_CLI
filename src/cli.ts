#!/usr/bin/env node

import 'dotenv/config';
import { Command } from 'commander';
import { startServer } from './server';
import { validateSpec } from './parser';
import { startReplayServer } from './proxy';
import { logError } from './logger';
import { AIOptions } from './types';

const parseEnvInt = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = parseInt(value, 10);
  return Number.isNaN(parsed) ? fallback : parsed;
};

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
  .option('--mode <mode>', 'Response generation: empty | random | ai', 'empty')
  .option('--ai-api-key <key>', 'openRouter API key (or set OPENROUTER_API_KEY env var)')
  .option('--ai-model <model>', 'LLM model (default: poolside/laguna-xs.2:free)')
  .option('--ai-temperature <n>', 'LLM temperature 0-2 (default: 0.7)', parseFloat)
  .option('--ai-cache-ttl <seconds>', 'Cache TTL in seconds (controlled by AI_CACHE_TTL env var)', parseInt)
  .option('--ai-fallback <mode>', 'Fallback mode on AI failure: empty | random (default: random)')
  .option('--ai-timeout <ms>', 'AI request timeout in ms (controlled by AI_TIMEOUT env var)', parseInt)
  .option('--ai-max-retries <n>', 'Max retries on validation failure (controlled by AI_MAX_RETRIES env var)', parseInt)
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
    if (opts.mode && !['empty', 'random', 'ai'].includes(opts.mode)) {
      logError(`Invalid --mode "${opts.mode}". Must be empty, random, or ai.`);
      process.exit(1);
    }

    // Validate AI mode requirements and determine final mode
    let finalMode = opts.mode as 'empty' | 'random' | 'ai';
    let aiOptions: any = undefined;

    if (finalMode === 'ai') {
      const apiKey = opts.aiApiKey || process.env.OPENROUTER_API_KEY;
      if (!apiKey) {
        console.warn('⚠️  Warning: AI mode requested but no API key found. Falling back to random mode.');
        console.warn('   Set OPENROUTER_API_KEY in .env file or use --ai-api-key flag.\n');
        finalMode = 'random';
      } else if (!apiKey.startsWith('sk-or-v1-')) {
        console.warn('⚠️  Warning: openRouter API key appears invalid (should start with "sk-or-v1-"). Falling back to random mode.');
        console.warn('   Please check your .env file or --ai-api-key value.\n');
        finalMode = 'random';
      } else {
        // API key is valid, enable AI mode
        aiOptions = {
          enabled: true,
          apiKey: opts.aiApiKey,
          model: opts.aiModel,
          temperature: opts.aiTemperature,
          cacheTtl: parseEnvInt(process.env.AI_CACHE_TTL, 300),
          fallback: opts.aiFallback as 'empty' | 'random' | 'ai' | undefined,
          timeout: parseEnvInt(process.env.AI_TIMEOUT, 10000),
          maxRetries: parseEnvInt(process.env.AI_MAX_RETRIES, 3)
        };
      }
    }

    try {
      await startServer({
        spec: opts.spec ?? '',
        from: opts.from,
        record: opts.record,
        mode: finalMode,
        port: parseInt(opts.port, 10),
        latency: opts.latency,
        seed: opts.seed !== undefined ? parseInt(opts.seed, 10) : undefined,
        includeOptional: opts.includeOptional as boolean,
        watch: opts.watch as boolean,
        logFormat: opts.logFormat as 'pretty' | 'json',
        quiet: opts.quiet as boolean,
        ai: aiOptions,
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
