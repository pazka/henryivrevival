import * as openaiClient from './myOpenAi';
import { rateLimit, safetyIdentifier, sameOrigin, validTurns } from './chatGuard';
import { configNamesSet, createLogger, errorRecorder, levelFrom, recordFailure, requestLogger } from './log';
import express from 'express';
import fs from 'fs';
import os from 'os';
import path from 'path';

// After the imports: myOpenAi has loaded .env (dotenv), so LOG_LEVEL may come from it too.
const log = createLogger(levelFrom(), process.stdout, process.env.APP_VERSION || 'dev');

const app = express();
// Logging standard (log.ts): X-Request-Id on every answer; only 5xx and slow answers are logged at info.
app.use(requestLogger(log));
// Express prints every error to stderr (stack, and body-parser's excerpt of a malformed body) unless its env is
// "test"; errorRecorder puts it in the JSON request line instead. Answers are unchanged: finalhandler only treats
// "production" differently, and that one is left as it is.
if (app.get('env') !== 'production') app.set('env', 'test');
// Behind the box's reverse proxy (one hop): req.ip is the visitor, not the proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(express.json({ limit: '32kb' }));

const PORT = process.env.PORT || 3000;
const FALLBACK = 'Il semble que je n\'ai pas de réponse à vous donner, je suis désolé.';

app.get('/chat/init', async (req, res) => {
    res.send(openaiClient.getInitMessages());
});

app.post('/chat/send', async (req, res) => {
    if (!sameOrigin(req)) return res.status(403).send('forbidden');
    const turns = validTurns(req.body);
    if (typeof turns === 'string') return res.status(400).send(turns);
    const limited = rateLimit(req.ip || '');
    if (limited) return res.status(429).send(limited);

    try {
        const visitorText = turns[turns.length - 1].content;
        const completion = await openaiClient.isFlagged(visitorText)
            ? openaiClient.MODERATED_ANSWER
            : await openaiClient.completeMessages(turns, safetyIdentifier(req));
        await openaiClient.createMp3FromText(completion || FALLBACK);
        res.send(completion);
    } catch (err: any) {
        // An OpenAI error used to be an unhandled rejection that killed the process. Logged by the request line
        // (request_failed) without the conversation or the key.
        recordFailure(res, {
            err, hide: [...turns.map(t => t.content), process.env.OPENAI_API_KEY || ''],
            fields: typeof err?.status === 'number' ? { openai_status: err.status } : {},
        });
        res.status(502).send(FALLBACK);
    }
});

// Kept for compatibility: the conversation lives in the browser, there is no server state to reset.
app.post('/chat', async (req, res) => {
    res.status(204).end();
});

app.get('/chat/complete/mp3/{*splat}', async (req, res) => {
    if (!fs.existsSync(openaiClient.TMP_AUDIO_FILE)) return res.status(404).send('no audio yet');
    res.sendFile(openaiClient.TMP_AUDIO_FILE);
});

// Capability probe for the box (compose healthcheck, hosh-deploy): never calls OpenAI (it costs money) and never
// shows the key. ok = the key is configured, the séance's static files are present, and the temp dir where the
// answer mp3 is written is writable.
const STATIC_FILES = ['index.html', 'sceance.mjs', 'speech.mjs', 'openai.mjs', 'henry.jpg'];
const staticFilesPresent = () => STATIC_FILES.every(f => fs.existsSync(path.join('public', f)));
function tmpWritable(): boolean {
    try {
        const probe = path.join(os.tmpdir(), `.healthz-${process.pid}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch {
        return false;
    }
}
app.get('/healthz', (req, res) => {
    const openai_key = Boolean(process.env.OPENAI_API_KEY);
    const static_files = staticFilesPresent();
    const tmp_writable = tmpWritable();
    const ok = openai_key && static_files && tmp_writable;
    res.set('cache-control', 'no-store').status(ok ? 200 : 503).json({
        status: ok ? 'ok' : 'error', openai_key, static_files, tmp_writable,
        chat_model: openaiClient.CHAT_MODEL, tts_model: openaiClient.TTS_MODEL,
    });
});

app.use(express.static('public'));
app.use(errorRecorder);

const server = app.listen(PORT, () => {
    // The only data dir is the temp dir of the answer mp3 (tmpfs /tmp in the image).
    log.info('startup', `Server started on http://localhost:${PORT}`, {
        port: Number(PORT), tmp_writable: tmpWritable(), static_files: staticFilesPresent(),
        chat_model: openaiClient.CHAT_MODEL, tts_model: openaiClient.TTS_MODEL,
        log_level: log.level, config: configNamesSet(),
    });
});

// docker stop (SIGTERM; node is PID 1 in the image): one line, stop accepting, exit 0 once the open answers are
// done (at most 1 s).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
        log.info('shutdown', 'stopping', { signal, uptime_s: Math.round(process.uptime()) });
        server.close(() => process.exit(0));
        server.closeIdleConnections();
        setTimeout(() => process.exit(0), 1000).unref();
    });
}
