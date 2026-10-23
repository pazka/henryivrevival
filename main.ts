import * as openaiClient from './myOpenAi';
import { rateLimit, safetyIdentifier, sameOrigin, validTurns } from './chatGuard';
import express from 'express';
import fs from 'fs';

const app = express();
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
        // An OpenAI error used to be an unhandled rejection that killed the process.
        console.error('chat/send failed:', err?.status ?? '', err?.message ?? err);
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

app.use(express.static('public'));

app.listen(PORT, () => {
    console.log('Server started on http://localhost:3000');
});
