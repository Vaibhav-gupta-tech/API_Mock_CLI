/**
 * latency.ts
 * ----------
 * Converts the raw --latency string the user types into a concrete number of
 * milliseconds to sleep before sending each response.
 *
 * SUPPORTED FORMATS
 * ─────────────────
 *  "0"                      → no delay
 *  "200"                    → fixed 200ms
 *  "50-500"                 → uniform random between 50ms and 500ms
 *  "p50=80,p95=300,p99=1200"→ log-normal distribution matching those percentiles
 *  "slow-3g"                → preset
 *  "realistic"              → preset
 *  "db-heavy"               → preset
 *
 * All latency is ADDITIVE — it is applied on top of actual server response time
 * so the total client-perceived latency is: (processing time) + (simulated delay).
 *
 * MATH: LOG-NORMAL LATENCY
 * ────────────────────────
 * Real-world API latencies are well-modelled by a log-normal distribution:
 *   ln(X) ~ Normal(μ, σ²)
 *
 * We fit μ and σ from the user-supplied percentile targets by solving:
 *   P_k = exp(μ + z_k * σ)   where z_k is the standard normal quantile for P_k
 *
 * Two equations (p50 and p95) give us two unknowns (μ, σ).
 * p50 → z = 0  so  μ = ln(p50)
 * p95 → z = 1.645  so  σ = (ln(p95) - μ) / 1.645
 *
 * We sample from Normal(0,1) using the Box-Muller transform and then exponentiate.
 */

import { LatencyConfig } from './types';

// ─── Named presets ────────────────────────────────────────────────────────────

const PRESETS: Record<string, LatencyConfig> = {
  // Simulates a slow 3G mobile connection
  'slow-3g': { min: 0, max: 0, logNormal: true, p50: 1000, p95: 2000, p99: 4000 },
  // A well-tuned production API (e.g. behind a CDN with fast DB)
  'realistic': { min: 0, max: 0, logNormal: true, p50: 80, p95: 250, p99: 600 },
  // Database-heavy operations (complex queries, joins, aggregations)
  'db-heavy': { min: 0, max: 0, logNormal: true, p50: 300, p95: 1200, p99: 3000 },
  // No delay — useful for benchmarking
  '0': { min: 0, max: 0 },
};

// ─── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parse the raw latency string into a LatencyConfig object.
 *
 * @param raw  The value the user passed to --latency, e.g. "50-500".
 * @returns    A LatencyConfig describing how to compute the delay.
 * @throws     Human-readable error if the format is unrecognised.
 */
export function parseLatency(raw: string): LatencyConfig {
  const trimmed = raw.trim();

  // ── Named preset ─────────────────────────────────────────────────────────
  if (PRESETS[trimmed]) {
    return { ...PRESETS[trimmed] };
  }

  // ── Fixed milliseconds: "200" ─────────────────────────────────────────────
  if (/^\d+$/.test(trimmed)) {
    const ms = parseInt(trimmed, 10);
    return { min: ms, max: ms };
  }

  // ── Uniform range: "50-500" ───────────────────────────────────────────────
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/);
  if (rangeMatch) {
    const min = parseInt(rangeMatch[1], 10);
    const max = parseInt(rangeMatch[2], 10);
    if (min > max) {
      throw new Error(`Latency range min (${min}) must be ≤ max (${max}).`);
    }
    return { min, max };
  }

  // ── Percentile targets: "p50=80,p95=300,p99=1200" ────────────────────────
  const percentileMatch = trimmed.match(/^p\d+=\d+/);
  if (percentileMatch) {
    const config: LatencyConfig = { min: 0, max: 0, logNormal: true };
    for (const part of trimmed.split(',')) {
      const m = part.match(/^p(\d+)=(\d+)$/);
      if (!m) throw new Error(`Invalid percentile spec: "${part}". Expected format: p50=80`);
      const percentile = parseInt(m[1], 10);
      const ms = parseInt(m[2], 10);
      if (percentile === 50)  config.p50 = ms;
      else if (percentile === 95) config.p95 = ms;
      else if (percentile === 99) config.p99 = ms;
    }
    if (!config.p50 && !config.p95) {
      throw new Error('Percentile latency requires at least p50 and p95 values.');
    }
    return config;
  }

  throw new Error(
    `Unrecognised --latency value: "${raw}".\n` +
    `Expected: a number ("200"), range ("50-500"), percentiles ("p50=80,p95=300,p99=1200"),\n` +
    `or a preset: slow-3g | realistic | db-heavy | 0`,
  );
}

// ─── Sampler ─────────────────────────────────────────────────────────────────

/**
 * Sample a concrete delay in milliseconds from a LatencyConfig.
 *
 * @param config  A parsed LatencyConfig.
 * @returns       Number of milliseconds to sleep.
 */
export function sampleLatency(config: LatencyConfig): number {
  if (config.logNormal) {
    return sampleLogNormal(config);
  }

  // Uniform [min, max]
  if (config.min === config.max) return config.min;
  return Math.floor(Math.random() * (config.max - config.min + 1)) + config.min;
}

/**
 * Sleep for exactly `ms` milliseconds.
 * Returns a Promise that resolves after the delay.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Log-normal sampler ───────────────────────────────────────────────────────

/**
 * Sample from a log-normal distribution fitted to the provided percentile targets.
 *
 * If only p50 is provided, σ defaults to 0.5 (a moderate spread).
 * If both p50 and p95 are provided, σ is calculated exactly.
 *
 * The result is clamped to [0, p99 * 2] to avoid pathological outliers.
 */
function sampleLogNormal(config: LatencyConfig): number {
  const p50 = config.p50 ?? 100;
  const p95 = config.p95 ?? p50 * 3;

  // μ = ln(p50)  (because at z=0, P = exp(μ))
  const mu = Math.log(p50);

  // σ = (ln(p95) - ln(p50)) / z_0.95
  // z_0.95 ≈ 1.6449 (standard normal quantile for 95th percentile)
  const Z_95 = 1.6449;
  const sigma = (Math.log(p95) - mu) / Z_95;

  // Sample from Normal(0, 1) via Box-Muller transform
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);

  // Transform to log-normal: X = exp(μ + σ * Z)
  const sample = Math.exp(mu + sigma * z);

  // Clamp to avoid extreme outliers
  const maxMs = config.p99 ? config.p99 * 2 : p95 * 4;
  return Math.max(0, Math.min(Math.round(sample), maxMs));
}
