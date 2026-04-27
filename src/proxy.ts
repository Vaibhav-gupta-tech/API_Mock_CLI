import fetch from 'node-fetch';
import * as fs from 'fs';
import express from 'express';
import { Request } from 'express';
import { logRequest, logStartup } from './logger';
import { ReplayOptions } from './types';

export interface ProxyResult {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export async function proxyRequest(upstream: string, req: Request): Promise<ProxyResult> {
  const base = upstream.replace(/\/$/, '');
  const targetUrl = base + req.url;

  const forwardHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string' && key.toLowerCase() !== 'host') {
      forwardHeaders[key] = value;
    }
  }

  const noBody = ['GET', 'HEAD', 'DELETE'].includes(req.method.toUpperCase());
  const bodyPayload = !noBody && req.body
    ? (typeof req.body === 'string' ? req.body : JSON.stringify(req.body))
    : undefined;

  const response = await fetch(targetUrl, {
    method: req.method,
    headers: forwardHeaders,
    body: bodyPayload,
  });

  const body = await response.buffer();
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => { headers[key] = value; });

  return { status: response.status, headers, body };
}

// ─── HAR recording ────────────────────────────────────────────────────────────

interface HarEntry {
  startedDateTime: string;
  request: {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
    queryString: { name: string; value: string }[];
    bodySize: number;
  };
  response: {
    status: number;
    statusText: string;
    headers: { name: string; value: string }[];
    content: { mimeType: string; text: string };
    bodySize: number;
  };
}

export function createHarRecorder(outputPath: string) {
  const entries: HarEntry[] = [];

  const flush = () => {
    fs.writeFileSync(outputPath, JSON.stringify({
      log: { version: '1.2', creator: { name: 'apimock', version: '1.0.0' }, entries },
    }, null, 2), 'utf-8');
  };

  return {
    record(req: Request, result: ProxyResult) {
      entries.push({
        startedDateTime: new Date().toISOString(),
        request: {
          method: req.method,
          url: req.url,
          headers: Object.entries(req.headers as Record<string, string>)
            .map(([name, value]) => ({ name, value })),
          queryString: Object.entries(req.query as Record<string, string>)
            .map(([name, value]) => ({ name, value })),
          bodySize: -1,
        },
        response: {
          status: result.status,
          statusText: String(result.status),
          headers: Object.entries(result.headers).map(([name, value]) => ({ name, value })),
          content: {
            mimeType: result.headers['content-type'] ?? 'application/octet-stream',
            text: result.body.toString('utf-8'),
          },
          bodySize: result.body.length,
        },
      });
      flush();
    },
  };
}

// ─── HAR replay server ────────────────────────────────────────────────────────

export async function startReplayServer(opts: ReplayOptions): Promise<void> {
  const harContent = fs.readFileSync(opts.session, 'utf-8');
  const har = JSON.parse(harContent) as { log: { entries: HarEntry[] } };
  const entries = har.log.entries;

  const app = express();

  app.use((req, res) => {
    const startTime = Date.now();

    const entry = entries.find(e =>
      e.request.method.toUpperCase() === req.method.toUpperCase() &&
      (e.request.url === req.url || e.request.url.split('?')[0] === req.path)
    );

    if (!entry) {
      const latencyMs = Date.now() - startTime;
      logRequest(
        { method: req.method, path: req.path, status: 404, mode: 'replay', latencyMs, matched: false },
        { format: opts.logFormat, quiet: opts.quiet },
      );
      return res.status(404).json({ error: 'No matching entry in HAR session', path: req.path });
    }

    const { response } = entry;
    const latencyMs = Date.now() - startTime;
    logRequest(
      { method: req.method, path: req.path, status: response.status, mode: 'replay', latencyMs, matched: true },
      { format: opts.logFormat, quiet: opts.quiet },
    );

    res.status(response.status);
    response.headers.forEach(({ name, value }) => {
      if (!['content-encoding', 'transfer-encoding', 'connection'].includes(name.toLowerCase())) {
        res.setHeader(name, value);
      }
    });
    res.send(response.content.text);
  });

  await new Promise<void>(resolve => {
    app.listen(opts.port, () => {
      logStartup({
        port: opts.port,
        spec: opts.session,
        mode: 'replay',
        latency: undefined,
        routes: entries.length,
        watch: false,
      });
      resolve();
    });
  });
}
