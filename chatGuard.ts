// Protection of POST /chat/send, the only route that spends OpenAI credit. Follows OpenAI's
// safety best practices for public apps without accounts: the server owns the system prompt, inputs are
// constrained, output tokens are capped (myOpenAi.ts), each request carries a hashed safety_identifier,
// visitor text goes through the moderation endpoint, and usage is rate-limited per visitor and in total.
import { createHash, randomBytes } from 'crypto';
import type { Request } from 'express';

const num = (name: string, dflt: number) => Number(process.env[name] || dflt);

export const LIMITS = {
  maxTurns: num('CHAT_MAX_TURNS', 20),           // the séance script needs ~10 (bonjour + 3 questions + farewell)
  maxChars: num('CHAT_MAX_CHARS', 500),          // per message
  perMinute: num('CHAT_RATE_PER_MINUTE', 6),     // per visitor (IP)
  perHour: num('CHAT_RATE_PER_HOUR', 60),
  perDay: num('CHAT_DAILY_BUDGET', 500),          // all visitors together: caps the bill
};

export type Turn = { role: 'user' | 'assistant', content: string };

/** Turns the browser may send: alternating user/assistant text, ending with the visitor. System messages
 *  (the front echoes the one from /chat/init) are dropped: the server always adds its own. */
export function validTurns(body: any): Turn[] | string {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return 'messages must be an array';
  const turns = messages.filter((m: any) => m?.role !== 'system');
  if (turns.length === 0 || turns.length > LIMITS.maxTurns) return `between 1 and ${LIMITS.maxTurns} messages`;
  for (const m of turns) {
    if (m?.role !== 'user' && m?.role !== 'assistant') return 'role must be user or assistant';
    if (typeof m.content !== 'string' || m.content.length === 0) return 'content must be a non-empty string';
    if (m.content.length > LIMITS.maxChars) return `a message is limited to ${LIMITS.maxChars} characters`;
  }
  if (turns[turns.length - 1].role !== 'user') return 'the last message must be the visitor\'s';
  return turns.map((m: any) => ({ role: m.role, content: m.content }));
}

/** Browsers send Origin on cross-site POSTs: refuse other sites using this endpoint with a visitor's IP. */
export function sameOrigin(req: Request): boolean {
  const origin = req.get('origin');
  if (!origin) return true; // non-browser clients are still subject to the limits below
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

// Hashed, never the raw IP (OpenAI: "hash the username or email ... to avoid sending us any identifying
// information"). Salted per process so the value cannot be reversed by trying every IP.
const SALT = process.env.SAFETY_ID_SALT || randomBytes(16).toString('hex');
export function safetyIdentifier(req: Request): string {
  return 'henry-' + createHash('sha256').update(SALT + (req.ip || '')).digest('hex').slice(0, 32);
}

const hits = new Map<string, number[]>();
let day = '';
let dayCount = 0;

/** null when allowed, otherwise the reason to refuse with 429. Counts the request when allowed. */
export function rateLimit(key: string, now = Date.now()): string | null {
  const today = new Date(now).toISOString().slice(0, 10);
  if (today !== day) { day = today; dayCount = 0; }
  if (dayCount >= LIMITS.perDay) return 'Henri IV se repose. Revenez demain.';
  const recent = (hits.get(key) || []).filter(t => now - t < 3600_000);
  if (recent.filter(t => now - t < 60_000).length >= LIMITS.perMinute) return 'Trop de questions à la fois. Patientez une minute.';
  if (recent.length >= LIMITS.perHour) return 'Trop de questions. Revenez plus tard.';
  recent.push(now);
  hits.set(key, recent);
  dayCount++;
  return null;
}
