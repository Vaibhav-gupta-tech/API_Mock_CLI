/**
 * cache.ts
 * --------
 * Simple in-memory cache for AI-generated responses to reduce API calls.
 * Uses node-cache for TTL support.
 */

import NodeCache from 'node-cache';
import { AIOptions } from './types';

export class AICache {
  private cache: NodeCache;

  constructor(ttlSeconds: number = 300) {
    this.cache = new NodeCache({ stdTTL: ttlSeconds, checkperiod: ttlSeconds / 10 });
  }

  /**
   * Generate cache key from route, params, and body.
   */
  private generateKey(route: string, method: string, params: any, body: any): string {
    const keyData = {
      route,
      method,
      params: JSON.stringify(params),
      body: JSON.stringify(body)
    };
    const key = Buffer.from(JSON.stringify(keyData)).toString('base64');
    return key;
  }

  /**
   * Get cached response if available.
   */
  get(route: string, method: string, params: any, body: any): string | undefined {
    const key = this.generateKey(route, method, params, body);
    return this.cache.get<string>(key);
  }

  /**
   * Cache a response.
   */
  set(route: string, method: string, params: any, body: any, response: string): void {
    const key = this.generateKey(route, method, params, body);
    this.cache.set(key, response);
  }

  /**
   * Clear all cached responses.
   */
  clear(): void {
    this.cache.flushAll();
  }

  /**
   * Get cache statistics.
   */
  getStats(): { keys: number; hits: number; misses: number; ksize: number; vsize: number } {
    return this.cache.getStats();
  }
}

// Global cache instance
let globalCache: AICache | null = null;

/**
 * Get or create global AI cache instance.
 */
export function getAICache(options: AIOptions): AICache | null {
  if (!options.enabled || (options.cacheTtl || 300) === 0) {
    return null; // No caching
  }

  if (!globalCache) {
    globalCache = new AICache(options.cacheTtl || 300);
  }

  return globalCache;
}