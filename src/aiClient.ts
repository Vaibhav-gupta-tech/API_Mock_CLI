/**
 * aiClient.ts
 * -----------
 * Client for interacting with openRouter API for AI-powered mock data generation.
 * openRouter provides access to multiple LLMs with a unified API (similar to OpenAI).
 */

import fetch from 'node-fetch';
import { AIOptions } from './types';

export interface AIRequest {
  prompt: string;
  temperature?: number;
  maxTokens?: number;
}

export interface AIResponse {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

/**
 * Client for openRouter API calls.
 * Handles authentication, retries, and error handling.
 */
export class AIClient {
  private apiKey: string;
  private baseUrl = 'https://openrouter.ai/api/v1';
  private defaultModel = 'poolside/laguna-xs.2:free'; // Free coding agent model

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  /**
   * Generate text using openRouter API with fallback models.
   */
  async generate(request: AIRequest, options: AIOptions): Promise<AIResponse> {
    const models = [
      options.model || this.defaultModel,
      'poolside/laguna-m.1:free', // Fallback free model
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free' // Another fallback
    ];

    let lastError: Error | null = null;

    for (const model of models) {
      try {
        const temperature = options.temperature || 0.7;
        const timeout = options.timeout || 10000;

        const payload = {
          model,
          messages: [
            {
              role: 'user',
              content: request.prompt
            }
          ],
          temperature,
          max_tokens: request.maxTokens || 1000
        };

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeout);

        try {
          const response = await fetch(`${this.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://github.com/Vaibhav-gupta-tech/API_Mock_CLI',
              'X-OpenRouter-Title': 'API Mock CLI'
            },
            body: JSON.stringify(payload),
            signal: controller.signal
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            const errorText = await response.text();
            let errorMessage = `openRouter API error: ${response.status} ${response.statusText}`;

            // Check for specific error types
            if (response.status === 401) {
              errorMessage = 'Invalid API key - authentication failed';
            } else if (response.status === 429) {
              errorMessage = 'Rate limit exceeded - daily limit reached or too many requests';
            } else if (response.status === 402) {
              errorMessage = 'Insufficient credits - payment required';
            } else if (errorText) {
              errorMessage += ` - ${errorText}`;
            }

            throw new Error(errorMessage);
          }

          const data = await response.json();

          return {
            text: data.choices[0]?.message?.content || '',
            usage: data.usage
          };
        } catch (error) {
          clearTimeout(timeoutId);
          if (error instanceof Error && error.name === 'AbortError') {
            throw new Error('AI request timed out');
          }
          lastError = error as Error;
          console.warn(`Model ${model} failed: ${lastError.message}. Trying next model...`);
          continue; // Try next model
        }
      } catch (error) {
        lastError = error as Error;
        continue;
      }
    }

    // All models failed
    throw lastError || new Error('All AI models failed');
  }
}

/**
 * Factory function to create AI client with API key from env.
 */
export function createAIClient(options: AIOptions): AIClient | null {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null; // AI not available
  }

  // Validate API key format
  if (!apiKey.startsWith('sk-or-v1-')) {
    console.warn('Warning: openRouter API key should start with "sk-or-v1-". Please check your .env file.');
  }

  return new AIClient(apiKey);
}