// Logging standard (pazka/hosh-management AGENTS.md section 11), on the compiled dist/log.js and dist/main.js
// (build first: `npx tsc`): stdout only, one JSON object per line (ts, level, service, version, event, msg); one
// startup and one shutdown line; requests logged only when they fail (5xx, with err) or are slow (warn), /healthz
// at debug; X-Request-Id echoed or replaced; never the conversation, a body, a raw path, a query, an IP, a user
// agent or the OpenAI key. OpenAI is a local fake (OPENAI_BASE_URL), with a dummy key.
// Node built-ins plus the app's own express:  npx tsc && node --test test/log.test.js
'use strict'

const {test, before, after} = require('node:test')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const express = require('express')
const L = require('../dist/log')

const ROOT = path.join(__dirname, '..')
const KEY = 'sk-test-log-0123456789abcdef'
const TS = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEAD = ['ts', 'level', 'service', 'version', 'event', 'msg']
const mark = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
const sleep = ms => new Promise(r => setTimeout(r, ms))

function memLogger(level) {
    const lines = []
    const logger = L.createLogger(level, {write: s => lines.push(s)}, 'v1.2.3')
    return {logger, lines, parsed: () => lines.map(l => JSON.parse(l))}
}

// ---- unit: dist/log.js -------------------------------------------------------------------------------------

test('createLogger: one JSON object per line with ts, level, service, version, event, msg, then the fields', () => {
    const {logger, lines, parsed} = memLogger('info')
    logger.info('startup', 'hello', {port: 1})
    assert.equal(lines.length, 1)
    assert.ok(lines[0].endsWith('\n') && !lines[0].slice(0, -1).includes('\n'))
    const o = parsed()[0]
    assert.deepEqual(Object.keys(o), [...HEAD, 'port'])
    assert.match(o.ts, TS)
    assert.ok(Math.abs(Date.parse(o.ts) - Date.now()) < 5000)
    assert.deepEqual([o.level, o.service, o.version, o.event, o.msg, o.port], ['info', 'henryivrevival', 'v1.2.3', 'startup', 'hello', 1])
})

test('createLogger: the level filters (default and unknown = info); LOG_LEVEL, else APP_LOG_LEVEL', () => {
    const levels = l => {
        const {logger, parsed} = memLogger(l)
        for (const x of ['debug', 'info', 'warn', 'error']) logger[x]('e', x)
        return parsed().map(o => o.level)
    }
    assert.deepEqual(levels('debug'), ['debug', 'info', 'warn', 'error'])
    assert.deepEqual(levels('info'), ['info', 'warn', 'error'])
    assert.deepEqual(levels(undefined), ['info', 'warn', 'error'])
    assert.deepEqual(levels('loud'), ['info', 'warn', 'error'])
    assert.deepEqual(levels('warn'), ['warn', 'error'])
    assert.deepEqual(levels('error'), ['error'])
    assert.equal(L.createLogger('nope', {write() {}}, 'x').level, 'info')
    assert.equal(L.levelFrom({LOG_LEVEL: 'warn', APP_LOG_LEVEL: 'debug'}), 'warn')
    assert.equal(L.levelFrom({APP_LOG_LEVEL: 'debug'}), 'debug')
    assert.equal(L.levelFrom({LOG_LEVEL: '', APP_LOG_LEVEL: 'error'}), 'error')
    assert.equal(L.levelFrom({}), undefined)
})

test('configNamesSet lists the names that are set, never a value', () => {
    assert.deepEqual(L.configNamesSet({PORT: '8000', OPENAI_API_KEY: KEY, CHAT_DAILY_BUDGET: '', APP_LOG_LEVEL: 'debug', OTHER: 'x'}),
        ['PORT', 'OPENAI_API_KEY', 'APP_LOG_LEVEL'])
    assert.deepEqual(L.configNamesSet({}), [])
})

test('errField: type, message, stack frames; hidden words and anything shaped like an OpenAI key removed', () => {
    const e = new TypeError('Incorrect API key provided: sk-proj-****abcd for "Bonjour Henri" (allow list)')
    const {err} = L.errField(e, ['Bonjour Henri', 'all'])
    assert.equal(err.type, 'TypeError')
    assert.equal(err.message, 'Incorrect API key provided: <hidden> for "<hidden>" (allow list)')
    const lines = err.stack.split('\n')
    assert.equal(lines[0], `TypeError: ${err.message}`)
    assert.ok(lines.length > 1 && lines.slice(1).every(l => /^\s+at /.test(l)), err.stack)
    assert.ok(!/Bonjour|sk-proj|abcd/.test(err.stack))
    // a multi-line message: the stack keeps only the frames, so the second line never leaks
    assert.ok(!L.errField(new Error('one\nBonjour Henri two'), ['Bonjour Henri']).err.stack.includes('Bonjour'))
    assert.deepEqual(L.errField('boom Bonjour', ['Bonjour']), {err: {type: 'string', message: 'boom <hidden>'}})
    assert.equal(L.errField(new Error('x.y?z'), ['x.y?z']).err.message, '<hidden>') // regex characters are literal
    assert.equal(L.errField(new Error('a b'), ['a', '']).err.message, 'a b')        // 1-char and empty words are kept
    class AuthenticationError extends Error {}
    assert.equal(L.errField(new AuthenticationError('401')).err.type, 'AuthenticationError')
})

test('urlParts: the URL, path, query and the request segments, not the fixed route words', () => {
    const parts = L.urlParts('/chat/complete/mp3/r%C3%A9union.mp3?q=1')
    for (const p of ['/chat/complete/mp3/r%C3%A9union.mp3?q=1', '/chat/complete/mp3/r%C3%A9union.mp3', 'q=1', 'r%C3%A9union.mp3', 'réunion.mp3'])
        assert.ok(parts.includes(p), p)
    for (const w of ['chat', 'complete', 'mp3', '']) assert.ok(!parts.includes(w), w)
    assert.ok(L.urlParts('/%E0').includes('%E0')) // not decodable: the raw segment is still hidden
})

test('requestId: a plain token of at most 64 characters is kept, anything else is replaced', () => {
    assert.equal(L.requestId('abc-123_x.y:z'), 'abc-123_x.y:z')
    assert.equal(L.requestId('a'.repeat(64)), 'a'.repeat(64))
    assert.equal(L.requestId(['first', 'second']), 'first')
    for (const bad of [undefined, '', 'a'.repeat(65), 'has space', 'x"}{', 'é', 'a\nb', ['a b']])
        assert.match(L.requestId(bad), UUID, String(bad))
})

test('routeOf: route templates, never the raw path or the query', () => {
    const cases = {
        '/healthz': '/healthz', '/healthz?x=Secret1': '/healthz', '/': '/', '/?x=Secret1': '/',
        '/chat/init': '/chat/init', '/chat/send': '/chat/send', '/CHAT/SEND?Secret1': '/chat/send',
        '/chat': '/chat', '/chat/': '/chat',
        '/chat/complete/mp3/Secret1.mp3': '/chat/complete/mp3/*', '/chat/complete/mp3/a/Secret1.mp3': '/chat/complete/mp3/*',
        '/Secret1.mjs': '/:file', '/Secret1': '/:file',
        '/Secret1/x': '(other)', '//': '(other)', '': '(other)',
    }
    for (const [url, route] of Object.entries(cases)) {
        assert.equal(L.routeOf(url), route, url)
        assert.ok(!L.routeOf(url).includes('Secret1'))
    }
})

// ---- requestLogger + recordFailure + errorRecorder on a real express app with a fake clock -----------------

async function withApp(level, fn) {
    const {logger, parsed} = memLogger(level)
    let clock = 0
    const app = express()
    app.set('env', 'test') // as main.ts: Express prints no error to stderr
    app.use(L.requestLogger(logger, () => clock))
    app.get('/healthz', (req, res) => res.status(Number(req.query.s || 200)).end())
    app.get('/chat/complete/mp3/{*splat}', (req, res) => {
        if (req.query.slow) clock += Number(req.query.slow)
        if (req.query.fail) throw new Error(`file ${req.params.splat.join('/')} broke`)
        if (req.query.rec) {
            L.recordFailure(res, {err: new Error(`upstream said ${req.query.rec}`), hide: [req.query.rec], fields: {openai_status: 401}})
            return res.status(502).end()
        }
        if (req.query.s) return res.status(Number(req.query.s)).end()
        res.send('ok')
    })
    app.use(L.errorRecorder)
    const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
    try {
        await fn(`http://127.0.0.1:${server.address().port}`, parsed)
    } finally {
        server.close()
    }
}

test('requests: 5xx at error with err, slow (> 1 s) at warn, others and /healthz only at debug', async () => {
    const R = '/chat/complete/mp3'
    await withApp('info', async (base, parsed) => {
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?q=Q1`)).status, 200)
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?s=404`)).status, 404)
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?s=429`)).status, 429)
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?slow=1000`)).status, 200)   // exactly 1 s: not slow
        assert.equal((await fetch(`${base}/healthz?s=503`)).status, 503)               // never above debug
        assert.equal((await fetch(`${base}/healthz`)).status, 200)
        await sleep(50)
        assert.deepEqual(parsed(), [])

        const failed = await fetch(`${base}${R}/Secret1.mp3?fail=1&q=Q2`, {headers: {'x-request-id': 'edge-42'}})
        assert.equal(failed.status, 500)
        assert.equal(failed.headers.get('x-request-id'), 'edge-42')
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?s=503`)).status, 503)
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?rec=Secret2`)).status, 502)
        assert.equal((await fetch(`${base}${R}/Secret1.mp3?slow=1001&q=Q3`)).status, 200)
        await sleep(50)
        const lines = parsed()
        assert.equal(lines.length, 4, JSON.stringify(lines))
        const [e1, e2, e3, w] = lines
        assert.deepEqual([e1.level, e1.event, e1.req_id, e1.method, e1.route, e1.status], ['error', 'request_failed', 'edge-42', 'GET', `${R}/*`, 500])
        assert.equal(typeof e1.dur_ms, 'number')
        assert.deepEqual([e1.err.type, e1.err.message], ['Error', 'file <hidden> broke'])
        assert.match(e1.err.stack, /^Error: file <hidden> broke\n\s+at /)
        assert.deepEqual(Object.keys(e2), [...HEAD, 'req_id', 'method', 'route', 'status', 'dur_ms'])
        assert.deepEqual([e2.level, e2.event, e2.status], ['error', 'request_failed', 503])
        assert.match(e2.req_id, UUID)
        assert.deepEqual([e3.level, e3.event, e3.status, e3.openai_status, e3.err.message], ['error', 'request_failed', 502, 401, 'upstream said <hidden>'])
        assert.deepEqual([w.level, w.event, w.route, w.status, w.dur_ms, w.err], ['warn', 'request_slow', `${R}/*`, 200, 1001, undefined])
        const all = JSON.stringify(lines)
        for (const s of ['Secret1', 'Secret2', 'Q2', 'Q3', 'fail=1', '127.0.0.1']) assert.ok(!all.includes(s), s)
    })
    await withApp('debug', async (base, parsed) => {
        await fetch(`${base}/healthz?s=503`)
        await fetch(`${base}${R}/Secret1.mp3`)
        await sleep(50)
        assert.deepEqual(parsed().map(o => [o.level, o.event, o.route, o.status]),
            [['debug', 'healthz', '/healthz', 503], ['debug', 'request', `${R}/*`, 200]])
    })
})

// ---- the real server (dist/main.js), black box, against a fake OpenAI -----------------------------------------

const calls = []
let fake, chatReply, speechReply, moderationReply
function completion(content) {
    return {status: 200, json: {id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-5.6-sol',
        choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content}}]}}
}

function startServer(port, {env = {}, cwd = ROOT, tmp, spawnOpts = {}} = {}) {
    tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'henry-log-'))
    const full = {...process.env, PORT: String(port), OPENAI_API_KEY: KEY, TMPDIR: tmp,
        OPENAI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`, CHAT_RATE_PER_MINUTE: '100', ...env}
    for (const k of ['LOG_LEVEL', 'APP_LOG_LEVEL', 'APP_VERSION']) if (!(k in env)) delete full[k]
    const s = {out: '', err: '', base: `http://127.0.0.1:${port}`, tmp}
    s.proc = spawn(process.execPath, [path.join(ROOT, 'dist', 'main.js')], {cwd, env: full, ...spawnOpts})
    s.proc.stdout.on('data', d => { s.out += d })
    s.proc.stderr.on('data', d => { s.err += d })
    s.lines = () => s.out.split('\n').filter(Boolean).map(l => JSON.parse(l))
    s.ready = (async () => {
        const until = Date.now() + 15000
        while (!s.out.includes('"event":"startup"')) {
            if (Date.now() > until || s.proc.exitCode !== null) throw new Error('server did not start:\n' + s.out + s.err)
            await sleep(50)
        }
    })()
    s.stop = () => {
        if (s.proc.exitCode === null) s.proc.kill('SIGKILL')
        fs.rmSync(tmp, {recursive: true, force: true})
    }
    return s
}

const send = (base, messages, headers = {}) => fetch(base + '/chat/send', {
    method: 'POST', headers: {'content-type': 'application/json', ...headers}, body: JSON.stringify({messages}),
})

let info, debug
before(async () => {
    fake = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', async () => {
            calls.push({url: req.url, body: JSON.parse(body || '{}')})
            const parsed = JSON.parse(body || '{}')
            if (req.url.endsWith('/audio/speech')) {
                const failed = speechReply && speechReply(parsed)
                if (failed) {
                    res.writeHead(failed.status, {'content-type': 'application/json'})
                    return res.end(JSON.stringify(failed.json))
                }
                res.writeHead(200, {'content-type': 'audio/mpeg'})
                return res.end('ID3fake')
            }
            if (req.url.endsWith('/moderations')) {
                const failed = moderationReply && moderationReply(parsed)
                if (failed) {
                    res.writeHead(failed.status, {'content-type': 'application/json'})
                    return res.end(JSON.stringify(failed.json))
                }
                res.writeHead(200, {'content-type': 'application/json'})
                return res.end(JSON.stringify({id: 'm', results: [{flagged: false, categories: {}, category_scores: {}}]}))
            }
            const {status, json, delay} = chatReply(JSON.parse(body || '{}'))
            if (delay) await sleep(delay)
            res.writeHead(status, {'content-type': 'application/json'})
            res.end(JSON.stringify(json))
        })
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
    info = startServer(3121, {env: {APP_VERSION: 'v9.8.7'}})
    debug = startServer(3122, {env: {APP_LOG_LEVEL: 'debug'}})
    await Promise.all([info.ready, debug.ready])
})
after(() => {
    info.stop()
    debug.stop()
    fake.closeAllConnections()
    fake.close()
})

test('server: the startup line (version, port, tmp dir writable, static files, models, config names without values)', () => {
    const starts = info.lines().filter(o => o.event === 'startup')
    assert.equal(starts.length, 1)
    const s = starts[0]
    assert.deepEqual(Object.keys(s), [...HEAD, 'port', 'tmp_writable', 'static_files', 'chat_model', 'tts_model', 'log_level', 'config'])
    assert.match(s.ts, TS)
    assert.deepEqual(s, {ts: s.ts, level: 'info', service: 'henryivrevival', version: 'v9.8.7', event: 'startup',
        msg: 'Server started on http://localhost:3121', port: 3121, tmp_writable: true, static_files: true,
        chat_model: 'gpt-5.6-sol', tts_model: 'tts-1', log_level: 'info',
        config: ['PORT', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CHAT_RATE_PER_MINUTE', 'APP_VERSION']})
    const text = JSON.stringify(s)
    for (const v of [KEY, info.tmp, String(fake.address().port)]) assert.ok(!text.includes(v), 'no config value: ' + v)
    const d = debug.lines().find(o => o.event === 'startup')
    assert.deepEqual([d.version, d.log_level, d.config], ['dev', 'debug',
        ['PORT', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CHAT_RATE_PER_MINUTE', 'APP_LOG_LEVEL']])
    assert.equal(info.err, '')
})

test('server: the startup line says tmp_writable:false and static_files:false when they are; LOG_LEVEL from .env; it still serves', async () => {
    // A temp dir that does not exist (the answer mp3 cannot be written) and a working directory without public/,
    // whose .env sets LOG_LEVEL (dotenv, loaded quietly: nothing on stderr).
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-logcwd-'))
    fs.writeFileSync(path.join(cwd, '.env'), 'LOG_LEVEL=debug\nOPENAI_CHAT_MODEL=gpt-from-dotenv\n')
    const s = startServer(3123, {cwd, tmp: path.join(cwd, 'missing', 'tmp')})
    try {
        await s.ready
        const st = s.lines().filter(o => o.event === 'startup')
        assert.equal(st.length, 1, s.out)
        assert.deepEqual([st[0].tmp_writable, st[0].static_files, st[0].log_level, st[0].chat_model], [false, false, 'debug', 'gpt-from-dotenv'])
        assert.ok(st[0].config.includes('LOG_LEVEL') && st[0].config.includes('OPENAI_CHAT_MODEL'))
        const h = await fetch(s.base + '/healthz')
        assert.equal(h.status, 503, 'still serves (and reports the same)')
        const hj = await h.json()
        assert.deepEqual([hj.tmp_writable, hj.static_files], [false, false])
        await sleep(50)
        assert.ok(s.lines().some(o => o.event === 'healthz' && o.level === 'debug'))
        assert.equal(s.err, '', 'nothing on stderr (no dotenv banner)')
    } finally {
        s.stop()
        fs.rmSync(cwd, {recursive: true, force: true})
    }
})

test('server: a chat round-trip logs nothing at info: never the visitor\'s or Henri\'s words', async () => {
    const m = mark()
    chatReply = () => completion(`Ventre-saint-gris ${m}-reply`)
    const before = info.out.length
    const r = await send(info.base, [{role: 'user', content: `Bonjour ${m}-visitor`}], {'user-agent': `ua-${m}`})
    assert.equal(r.status, 200)
    assert.equal(await r.text(), `Ventre-saint-gris ${m}-reply`)
    await sleep(100)
    assert.equal(info.out.slice(before), '')
    assert.equal(info.err, '')
})

test('server: an OpenAI error is one request_failed line with err and openai_status, without the key or the conversation; nothing on stderr', async () => {
    const m = mark()
    // OpenAI's 401 shows the key masked, and some errors quote the input: neither may reach the log.
    chatReply = () => ({status: 401, json: {error: {message: `Incorrect API key provided: sk-test-****cdef. Input was "Bonjour ${m}"`,
        type: 'invalid_request_error', code: 'invalid_api_key'}}})
    const r = await send(info.base, [{role: 'user', content: `Bonjour ${m}`}],
        {'x-request-id': `req-${m}`, 'user-agent': `ua-${m}`, 'x-forwarded-for': '203.0.113.9'})
    assert.equal(r.status, 502)
    assert.equal(r.headers.get('x-request-id'), `req-${m}`)
    assert.equal(await r.text(), "Il semble que je n'ai pas de réponse à vous donner, je suis désolé.")
    await sleep(100)
    const errs = info.lines().filter(o => o.req_id === `req-${m}`)
    assert.equal(errs.length, 1)
    const e = errs[0]
    assert.deepEqual(Object.keys(e), [...HEAD, 'req_id', 'method', 'route', 'status', 'dur_ms', 'openai_status', 'err'])
    assert.match(e.ts, TS)
    assert.deepEqual([e.level, e.service, e.version, e.event, e.msg, e.method, e.route, e.status, e.openai_status],
        ['error', 'henryivrevival', 'v9.8.7', 'request_failed', 'server error', 'POST', '/chat/send', 502, 401])
    assert.equal(typeof e.dur_ms, 'number')
    assert.deepEqual(Object.keys(e.err), ['type', 'message', 'stack'])
    assert.equal(e.err.type, 'AuthenticationError')
    assert.equal(e.err.message, '401 Incorrect API key provided: <hidden>. Input was "<hidden>"')
    assert.match(e.err.stack, /^AuthenticationError: 401 Incorrect API key provided: <hidden>\. Input was "<hidden>"\n\s+at /)
    const line = JSON.stringify(e)
    for (const s of [`Bonjour ${m}`, 'Input was "B', 'sk-test', `ua-${m}`, '203.0.113', '127.0.0.1']) assert.ok(!line.includes(s), s)
    assert.equal(info.err, '')
})

// The reply produced in this request is not in the turns sent by the browser: it is the TTS input, and an error that
// quotes its input must not put Henri's words in the log (nor the visitor's, quoted by a moderation error).
async function failedTurnLine(m) {
    const r = await send(info.base, [{role: 'user', content: `Bonjour ${m}-visitor`}], {'x-request-id': `req-${m}`})
    assert.equal(r.status, 502)
    assert.equal(await r.text(), "Il semble que je n'ai pas de réponse à vous donner, je suis désolé.")
    await sleep(100)
    const errs = info.lines().filter(o => o.req_id === `req-${m}`)
    assert.equal(errs.length, 1, info.out)
    return errs[0]
}

test('server: a TTS error that quotes its input is one request_failed line with openai_status, without Henri\'s reply or the visitor\'s words', async () => {
    const m = mark()
    chatReply = () => completion(`Ventre-saint-gris ${m}-reply`)
    speechReply = b => ({status: 400, json: {error: {message: `Invalid input: "${b.input}"`, type: 'invalid_request_error'}}})
    try {
        const e = await failedTurnLine(m)
        assert.deepEqual([e.level, e.event, e.route, e.status, e.openai_status], ['error', 'request_failed', '/chat/send', 502, 400])
        assert.equal(e.err.message, '400 Invalid input: "<hidden>"')
        assert.match(e.err.stack, /^BadRequestError: 400 Invalid input: "<hidden>"\n\s+at /)
        assert.ok(calls.some(c => c.url.endsWith('/audio/speech') && c.body.input === `Ventre-saint-gris ${m}-reply`), 'the TTS got the reply')
    } finally {
        speechReply = undefined
    }
    for (const s of [`${m}-reply`, `${m}-visitor`, 'Ventre-saint-gris']) assert.ok(!info.out.includes(s), s)
    assert.equal(info.err, '')
})

test('server: a moderation error that quotes its input is one request_failed line with openai_status, without the visitor\'s words', async () => {
    const m = mark()
    chatReply = () => completion(`Ventre-saint-gris ${m}-reply`)
    moderationReply = b => ({status: 400, json: {error: {message: `Invalid input: "${b.input}"`, type: 'invalid_request_error'}}})
    try {
        const e = await failedTurnLine(m)
        assert.deepEqual([e.level, e.event, e.route, e.status, e.openai_status], ['error', 'request_failed', '/chat/send', 502, 400])
        assert.equal(e.err.message, '400 Invalid input: "<hidden>"')
    } finally {
        moderationReply = undefined
    }
    for (const s of [`${m}-reply`, `${m}-visitor`]) assert.ok(!info.out.includes(s), s)
    assert.equal(info.err, '')
})

test('server: an error inside Express (the mp3 route) is one request_failed line with err; the answer is unchanged', async () => {
    // The answer file exists but cannot be read: sendFile fails inside Express (EACCES) and finalhandler answers
    // 500 (errorRecorder). As root (the CI test container) the server runs as nobody (65534), because root reads
    // anything; otherwise the file is chmod 000. Never skipped.
    const m = mark()
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'henry-log-eacces-'))
    const mp3 = path.join(tmp, 'henry-tmp.mp3')
    fs.writeFileSync(mp3, 'ID3')
    fs.chmodSync(mp3, 0o000)
    const asRoot = typeof process.getuid === 'function' && process.getuid() === 0
    if (asRoot) fs.chmodSync(tmp, 0o755) // nobody may list it, not read the root-owned file
    const s = startServer(3124, {tmp, env: {APP_VERSION: 'v9.8.7'}, spawnOpts: asRoot ? {uid: 65534, gid: 65534} : {}})
    try {
        await s.ready
        const r = await fetch(`${s.base}/chat/complete/mp3/${m}.mp3?q=${m}`, {headers: {'x-request-id': `mp3-${m}`}})
        const body = await r.text()
        assert.equal(r.status, 500, body)
        assert.match(body, /EACCES/)
        await sleep(100)
        const errs = s.lines().filter(o => o.level === 'error')
        assert.equal(errs.length, 1, s.out)
        const e = errs[0]
        assert.deepEqual(Object.keys(e), [...HEAD, 'req_id', 'method', 'route', 'status', 'dur_ms', 'err'])
        assert.deepEqual([e.event, e.version, e.req_id, e.method, e.route, e.status],
            ['request_failed', 'v9.8.7', `mp3-${m}`, 'GET', '/chat/complete/mp3/*', 500])
        assert.equal(e.err.type, 'Error')
        assert.match(e.err.message, /^EACCES: permission denied/)
        assert.equal(e.err.stack.split('\n')[0], `Error: ${e.err.message}`) // fs stream errors carry no frames
        assert.ok(!JSON.stringify(e).replace(`mp3-${m}`, '').includes(m), 'no path or query')
        assert.equal(s.err, '', 'stderr stays empty (Express no longer prints errors there)')
    } finally {
        s.stop()
    }
})

test('server: a slow chat (> 1 s) is one request_slow warn line, by route, without the conversation', async () => {
    const m = mark()
    chatReply = () => ({...completion(`slow ${m}-reply`), delay: 1100})
    const r = await send(info.base, [{role: 'user', content: `Bonjour ${m}`}], {'x-request-id': `slow-${m}`})
    assert.equal(r.status, 200)
    await sleep(100)
    const lines = info.lines().filter(o => o.req_id === `slow-${m}`)
    assert.equal(lines.length, 1)
    assert.deepEqual(Object.keys(lines[0]), [...HEAD, 'req_id', 'method', 'route', 'status', 'dur_ms'])
    assert.deepEqual([lines[0].level, lines[0].event, lines[0].route, lines[0].status], ['warn', 'request_slow', '/chat/send', 200])
    assert.ok(lines[0].dur_ms > 1000)
    assert.ok(!info.out.includes(`${m}-reply`) && !info.out.includes(`Bonjour ${m}`), 'no conversation')
})

test('server: refused and ordinary requests log nothing at info, nothing on stderr (bad JSON, 400, 413, 403, 404, /healthz)', async () => {
    const m = mark()
    const before = info.out.length
    const bad = await fetch(info.base + '/chat/send', {method: 'POST', headers: {'content-type': 'application/json'}, body: `{"messages":"B${m}`})
    assert.equal(bad.status, 400)
    const huge = await fetch(info.base + '/chat/send', {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({messages: [{role: 'user', content: `H${m}`.repeat(4000)}]})})
    assert.equal(huge.status, 413)
    assert.equal((await send(info.base, [{role: 'assistant', content: `V${m}`}])).status, 400)
    assert.equal((await send(info.base, [{role: 'user', content: `O${m}`}], {origin: 'https://other.example'})).status, 403)
    assert.equal((await fetch(`${info.base}/${m}.mjs?q=${m}`)).status, 404)
    assert.equal((await fetch(`${info.base}/healthz?h=${m}`)).status, 200)
    assert.equal((await fetch(`${info.base}/chat/init`)).status, 200)
    await sleep(150)
    assert.equal(info.out.slice(before), '')
    assert.equal(info.err, '')
})

test('server: X-Request-Id is echoed when it is a plain token, replaced otherwise, on every answer', async () => {
    const ok = await fetch(`${info.base}/chat/init`, {headers: {'x-request-id': 'abc.DEF-123'}})
    assert.equal(ok.headers.get('x-request-id'), 'abc.DEF-123')
    for (const bad of ['a'.repeat(65), 'two words', '"quoted"']) {
        const r = await fetch(`${info.base}/chat/init`, {headers: {'x-request-id': bad}})
        assert.match(r.headers.get('x-request-id'), UUID, bad)
    }
    assert.match((await fetch(`${info.base}/`)).headers.get('x-request-id'), UUID)
    assert.match((await fetch(`${info.base}/healthz`)).headers.get('x-request-id'), UUID)
    assert.match((await fetch(`${info.base}/chat`, {method: 'POST'})).headers.get('x-request-id'), UUID)
})

test('server (APP_LOG_LEVEL=debug): /healthz and every request at debug, by route; never an IP, path, query or the conversation', async () => {
    const m = mark()
    chatReply = () => completion(`R${m}`)
    const before = debug.out.length
    assert.equal((await fetch(`${debug.base}/healthz?h=${m}`)).status, 200)
    assert.equal((await fetch(`${debug.base}/${m}.jpg`)).status, 404)
    assert.equal((await fetch(`${debug.base}/sceance.mjs?v=${m}`)).status, 200)
    assert.equal((await send(debug.base, [{role: 'user', content: `Bonjour ${m}`}], {'x-forwarded-for': '198.51.100.7'})).status, 200)
    assert.equal((await fetch(`${debug.base}/chat/complete/mp3/${m}.mp3`)).status, 200)
    await sleep(150)
    const lines = debug.out.slice(before).split('\n').filter(Boolean).map(l => JSON.parse(l))
    assert.deepEqual(lines.map(o => [o.level, o.event, o.method, o.route, o.status]), [
        ['debug', 'healthz', 'GET', '/healthz', 200],
        ['debug', 'request', 'GET', '/:file', 404],
        ['debug', 'request', 'GET', '/:file', 200],
        ['debug', 'request', 'POST', '/chat/send', 200],
        ['debug', 'request', 'GET', '/chat/complete/mp3/*', 200],
    ])
    for (const o of lines) assert.deepEqual(Object.keys(o), [...HEAD, 'req_id', 'method', 'route', 'status', 'dur_ms'])
    const text = debug.out.slice(before)
    assert.ok(!text.includes(m), 'no path, query or conversation')
    assert.ok(!/127\.0\.0\.1|::ffff|::1|198\.51|sceance/.test(text), 'no IP, no raw path')
    assert.equal(debug.err, '')
})

test('server: every stdout line is a standard JSON line; SIGTERM / SIGINT write one shutdown line and exit 0 within about 1 s', async () => {
    for (const [s, signal] of [[info, 'SIGTERM'], [debug, 'SIGINT']]) {
        // SIGTERM (docker stop): an answer still waiting for OpenAI (8 s) must not hold the stop (docker would
        // SIGKILL after 10 s): exit 0 after at most 1 s. SIGINT: nothing in flight, exit 0 once the server is closed.
        let pending = null
        if (signal === 'SIGTERM') {
            chatReply = () => ({...completion('late'), delay: 8000})
            calls.length = 0
            pending = send(s.base, [{role: 'user', content: 'Bonjour'}]).catch(() => 'cut')
            while (!calls.some(c => c.url.endsWith('/chat/completions'))) await sleep(20)
        }
        const t0 = Date.now()
        s.proc.kill(signal)
        const code = await new Promise((r, j) => {
            if (s.proc.exitCode !== null) return r(s.proc.exitCode)
            const t = setTimeout(() => j(new Error(`no exit 5 s after ${signal}`)), 5000)
            s.proc.on('exit', c => { clearTimeout(t); r(c) })
        })
        assert.equal(code, 0, signal)
        assert.ok(Date.now() - t0 < 3000, `${signal}: exit after ${Date.now() - t0} ms`)
        if (pending) await pending
        const lines = s.out.split('\n').filter(Boolean)
        for (const l of lines) {
            const o = JSON.parse(l)
            assert.deepEqual(Object.keys(o).slice(0, 6), HEAD, l)
            assert.match(o.ts, TS)
            assert.ok(['debug', 'info', 'warn', 'error'].includes(o.level))
            assert.match(o.event, /^[a-z]+(_[a-z]+)*$/)
        }
        const downs = lines.map(l => JSON.parse(l)).filter(o => o.event === 'shutdown')
        assert.equal(downs.length, 1, signal)
        assert.deepEqual(Object.keys(downs[0]), [...HEAD, 'signal', 'uptime_s'])
        assert.deepEqual([downs[0].level, downs[0].msg, downs[0].signal], ['info', 'stopping', signal])
        assert.equal(typeof downs[0].uptime_s, 'number')
        assert.equal(s.err, '')
    }
    assert.equal(info.lines().find(o => o.event === 'shutdown').version, 'v9.8.7')
})
