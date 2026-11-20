// Logging standard (pazka/hosh-management AGENTS.md section 11): stdout only, one JSON object per line with
// ts, level, service, version, event (stable snake_case name, the thing to count), msg, then the line's own
// fields. Never a conversation (visitor or Henri text), a request body, a raw path or query string, an IP, a
// user agent, a cookie or a key.
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';

const LEVELS: { [level: string]: number } = { debug: 10, info: 20, warn: 30, error: 40 };

export const SERVICE = 'henryivrevival';
// A request slower than this is logged at warn.
export const SLOW_MS = 1000;
// The variables the server reads: the startup line lists the ones that are set, never their values.
export const CONFIG_NAMES = [
  'PORT', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_CHAT_MODEL', 'OPENAI_TTS_MODEL',
  'OPENAI_MAX_COMPLETION_TOKENS', 'CHAT_MAX_TURNS', 'CHAT_MAX_CHARS', 'CHAT_RATE_PER_MINUTE', 'CHAT_RATE_PER_HOUR',
  'CHAT_DAILY_BUDGET', 'TRUST_PROXY_HOPS', 'SAFETY_ID_SALT', 'LOG_LEVEL', 'APP_LOG_LEVEL', 'APP_VERSION',
];

export type LogFn = (event: string, msg: string, fields?: { [k: string]: any }) => void;
export interface Logger { level: string; debug: LogFn; info: LogFn; warn: LogFn; error: LogFn }

/** level: debug | info | warn | error (anything else: info). */
export function createLogger(level: string | undefined, out: { write: (s: string) => any }, version: string): Logger {
  const name = level && LEVELS[level] ? level : 'info';
  const min = LEVELS[name];
  const emit = (lvl: string): LogFn => (event, msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    out.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, service: SERVICE, version, event, msg, ...fields }) + '\n');
  };
  return { level: name, debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

/** LOG_LEVEL, or APP_LOG_LEVEL (the name the box template passes), default info. */
export function levelFrom(env: { [k: string]: string | undefined } = process.env): string | undefined {
  return env.LOG_LEVEL || env.APP_LOG_LEVEL;
}

export function configNamesSet(env: { [k: string]: string | undefined } = process.env): string[] {
  return CONFIG_NAMES.filter(n => env[n] !== undefined && env[n] !== '');
}

// An OpenAI key, whole or masked as OpenAI's own 401 message shows it ("sk-proj-****abcd").
const KEY_LIKE = /\bsk-[A-Za-z0-9_*-]+/g;

/** The `err` field of an error line: type, message, stack. Every string of `hide` (the visitor's text, the key...)
 *  found in the message is replaced by "<hidden>", and so is anything shaped like an OpenAI key; the stack keeps
 *  only its "at ..." frames under the cleaned message, so request data never reaches the log through an error. */
export function errField(e: any, hide: string[] = []): { err: { type: string, message: string, stack?: string } } {
  const secrets = hide.filter(h => typeof h === 'string' && h.length > 1).sort((a, b) => b.length - a.length);
  const word = (h: string) => new RegExp('(?<![A-Za-z0-9])' + h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![A-Za-z0-9])', 'g');
  const clean = (s: string) => secrets.reduce((t, h) => t.replace(word(h), '<hidden>'), s).replace(KEY_LIKE, '<hidden>');
  if (e instanceof Error) {
    const type = e.constructor?.name && e.constructor.name !== 'Object' ? e.constructor.name : (e.name || 'Error');
    const message = clean(String(e.message));
    const frames = String(e.stack || '').split('\n').filter(l => /^\s+at /.test(l));
    return { err: { type, message, stack: [`${type}: ${message}`, ...frames].join('\n') } };
  }
  return { err: { type: typeof e, message: clean(String(e)) } };
}

/** The edge's X-Request-Id when it is a plain token of at most 64 characters, else a new one. */
export function requestId(header: any): string {
  const v = Array.isArray(header) ? header[0] : header;
  return typeof v === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(v) ? v : randomUUID();
}

/** The route template of a request: never the raw path or its query. Express matches paths case-insensitively. */
export function routeOf(url: string): string {
  const p = String(url || '').split('?')[0];
  if (/^\/healthz\/?$/i.test(p)) return '/healthz';
  if (p === '/') return '/';
  if (/^\/chat\/init\/?$/i.test(p)) return '/chat/init';
  if (/^\/chat\/send\/?$/i.test(p)) return '/chat/send';
  if (/^\/chat\/?$/i.test(p)) return '/chat';
  if (/^\/chat\/complete\/mp3\/./i.test(p)) return '/chat/complete/mp3/*';
  if (/^\/[^/]+$/.test(p)) return '/:file';
  return '(other)';
}

// The fixed words of the routes (routeOf): not request data, and hiding them would garble messages.
const ROUTE_WORDS = ['', 'chat', 'init', 'send', 'complete', 'mp3', 'healthz'];

/** Everything of a URL that must not reach the log: the URL, its path, query, and each path segment (raw and decoded). */
export function urlParts(url: string): string[] {
  const s = String(url || '');
  const [p, q] = s.split('?');
  const parts = [s, p];
  if (q) parts.push(q);
  for (const seg of p.split('/')) {
    if (ROUTE_WORDS.includes(seg.toLowerCase())) continue;
    parts.push(seg);
    try { parts.push(decodeURIComponent(seg)); } catch { /* not decodable: the raw one is hidden */ }
  }
  return parts;
}

/** What a failed request leaves for its log line: the cleaned `err` and extra fields (never request data). */
export type Failure = { err: any, hide?: string[], fields?: { [k: string]: any } };
const failures = new WeakMap<object, Failure>();
export function recordFailure(res: object, failure: Failure) {
  failures.set(res, failure);
}

/** First middleware: X-Request-Id on every answer, then one line when the answer is done, only if it matters:
 *  a 5xx (error, with `err` when known), a slow answer (warn); anything else at debug; /healthz never above debug. */
export function requestLogger(logger: Logger, now: () => number = () => performance.now()) {
  return (req: any, res: any, next: Function) => {
    const start = now();
    const reqId = requestId(req.headers['x-request-id']);
    res.setHeader('X-Request-Id', reqId);
    const url = req.originalUrl || req.url;
    // "close" also fires when an answer is cut short, which "finish" never sees.
    res.on('close', () => {
      const route = routeOf(url);
      const fields: any = { req_id: reqId, method: req.method, route, status: res.statusCode, dur_ms: Math.round(now() - start) };
      if (!res.writableFinished) fields.aborted = true;
      const f = failures.get(res);
      if (route === '/healthz') logger.debug('healthz', 'healthz', fields);
      else if (res.statusCode >= 500) logger.error('request_failed', 'server error',
        f === undefined ? fields : { ...fields, ...(f.fields || {}), ...errField(f.err, f.hide) });
      else if (fields.dur_ms > SLOW_MS) logger.warn('request_slow', 'slow request', fields);
      else logger.debug('request', 'request', fields);
    });
    next();
  };
}

/** Last middleware: remembers the error for the request line, then lets Express answer exactly as before. */
export function errorRecorder(err: any, req: any, res: any, next: Function) {
  recordFailure(res, { err, hide: urlParts(req.originalUrl || req.url) });
  next(err);
}
