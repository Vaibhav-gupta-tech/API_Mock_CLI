import express from 'express';
import * as http from 'http';
import chokidar from 'chokidar';
import { loadSpec } from './parser';
import { generateResponseBody } from './generator';
import { parseLatency, sampleLatency, sleep } from './latency';
import { logRequest, logStartup, logReload, logError } from './logger';
import { ServeOptions, ParsedRoute, ParsedSpec } from './types';
import { proxyRequest, createHarRecorder } from './proxy';

// ─── Route table ──────────────────────────────────────────────────────────────

interface RouteEntry {
  route: ParsedRoute;
  regex: RegExp;
  paramNames: string[];
}

function buildRouteTable(routes: ParsedRoute[]): RouteEntry[] {
  return routes.map(route => {
    const paramNames: string[] = [];
    // Split on {paramName} to separate literals from params
    const parts = route.path.split(/\{([^}]+)\}/g);
    const pattern = parts.map((part, i) => {
      if (i % 2 === 0) {
        // Literal segment — escape regex metacharacters
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      } else {
        paramNames.push(part);
        return '([^/]+)';
      }
    }).join('');
    return { route, regex: new RegExp(`^${pattern}$`), paramNames };
  });
}

function matchRoute(table: RouteEntry[], method: string, pathname: string) {
  for (const entry of table) {
    if (entry.route.method !== method.toUpperCase()) continue;
    const m = pathname.match(entry.regex);
    if (m) {
      const pathParams: Record<string, string> = {};
      entry.paramNames.forEach((name, i) => { pathParams[name] = m[i + 1]; });
      return { route: entry.route, pathParams };
    }
  }
  return null;
}

// ─── Server entry point ───────────────────────────────────────────────────────

export async function startServer(opts: ServeOptions): Promise<void> {
  let parsedSpec: ParsedSpec = opts.spec
    ? await loadSpec(opts.spec)
    : { document: {} as never, routes: [] };
  let routeTable = buildRouteTable(parsedSpec.routes);

  const globalLatency = opts.latency ? parseLatency(opts.latency) : null;

  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  if (opts.from) {
    // ── Proxy mode ──────────────────────────────────────────────────────────
    const recorder = opts.record ? createHarRecorder(opts.record) : null;

    app.use(async (req, res) => {
      const startTime = Date.now();
      try {
        const result = await proxyRequest(opts.from!, req);
        if (recorder) recorder.record(req, result);

        res.status(result.status);
        for (const [key, value] of Object.entries(result.headers)) {
          if (!['content-encoding', 'transfer-encoding', 'connection'].includes(key.toLowerCase())) {
            res.setHeader(key, value);
          }
        }

        logRequest(
          { method: req.method, path: req.path, status: result.status, mode: 'proxy', latencyMs: Date.now() - startTime, matched: true },
          { format: opts.logFormat, quiet: opts.quiet },
        );
        res.send(result.body);
      } catch (err) {
        logRequest(
          { method: req.method, path: req.path, status: 502, mode: 'proxy', latencyMs: Date.now() - startTime, matched: false },
          { format: opts.logFormat, quiet: opts.quiet },
        );
        res.status(502).json({ error: 'Upstream request failed', detail: String(err) });
      }
    });
  } else {
    // ── Mock mode ───────────────────────────────────────────────────────────
    app.use(async (req, res) => {
      const startTime = Date.now();
      const matched = matchRoute(routeTable, req.method, req.path);

      if (!matched) {
        logRequest(
          { method: req.method, path: req.path, status: 404, mode: opts.mode, latencyMs: Date.now() - startTime, matched: false },
          { format: opts.logFormat, quiet: opts.quiet },
        );
        return res.status(404).json({ error: 'No matching route in spec', method: req.method, path: req.path });
      }

      const latencyCfg = matched.route.latencyOverride
        ? parseLatency(matched.route.latencyOverride)
        : globalLatency;
      await sleep(latencyCfg ? sampleLatency(latencyCfg) : 0);

      const { body, statusCode } = await generateResponseBody({
        route: matched.route,
        mode: opts.mode,
        seed: opts.seed,
        includeOptional: opts.includeOptional,
        pathParams: matched.pathParams,
        queryParams: req.query as Record<string, string>,
        ai: opts.ai,
        spec: parsedSpec,
      });

      logRequest(
        { method: req.method, path: req.path, status: statusCode, mode: opts.mode, latencyMs: Date.now() - startTime, matched: true },
        { format: opts.logFormat, quiet: opts.quiet },
      );

      if (body === null) return res.status(statusCode).send();
      return res.status(statusCode).json(body);
    });
  }

  const server = http.createServer(app);

  await new Promise<void>(resolve => {
    server.listen(opts.port, () => {
      logStartup({
        port: opts.port,
        spec: opts.from ? `proxy → ${opts.from}` : opts.spec,
        mode: opts.from ? 'proxy' : opts.mode,
        latency: opts.latency,
        routes: parsedSpec.routes.length,
        watch: opts.watch,
      });
      resolve();
    });
  });

  if (opts.watch && !opts.from && opts.spec) {
    const watcher = chokidar.watch(opts.spec, { ignoreInitial: true });
    watcher.on('change', async () => {
      try {
        parsedSpec = await loadSpec(opts.spec);
        routeTable = buildRouteTable(parsedSpec.routes);
        logReload(opts.spec);
      } catch (err) {
        logError('Spec reload failed', String(err));
      }
    });
  }
}
