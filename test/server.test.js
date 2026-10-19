// Upgrade safety net (see TESTING.md): black-box characterization tests of main.ts, started the way the image
// does (ts-node). OpenAI is replaced by a local fake server through OPENAI_BASE_URL: no network, no key.
// They pin what the app does TODAY, so a Node, ts-node, TypeScript, Express or openai SDK bump that changes
// behaviour fails here. Node built-ins only:  node --test --test-reporter=spec test/server.test.js
'use strict'

const {test, before, after} = require('node:test')
const assert = require('node:assert/strict')
const {spawn} = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const MP3 = Buffer.from('ID3fake-mp3-bytes')
const calls = []
let fake, reply

before(async () => {
    // Fake OpenAI: records every request, answers with `reply` (status + body).
    fake = http.createServer((req, res) => {
        let body = ''
        req.on('data', c => { body += c })
        req.on('end', () => {
            calls.push({method: req.method, url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}')})
            if (req.url.endsWith('/audio/speech')) {
                res.writeHead(200, {'content-type': 'audio/mpeg'})
                return res.end(MP3)
            }
            const {status, json} = reply()
            res.writeHead(status, {'content-type': 'application/json'})
            res.end(JSON.stringify(json))
        })
    })
    await new Promise(r => fake.listen(0, '127.0.0.1', r))
})

after(() => fake.close())

const completion = content => ({
    status: 200,
    json: {id: 'c1', object: 'chat.completion', created: 1, model: 'gpt-4o-2024-05-13',
        choices: [{index: 0, finish_reason: 'stop', message: {role: 'assistant', content}}]},
})

async function startApp(port) {
    let log = ''
    const p = spawn(process.execPath, [path.join(ROOT, 'node_modules', 'ts-node', 'dist', 'bin.js'), 'main.ts'], {
        cwd: ROOT,
        env: {...process.env, PORT: String(port), OPENAI_API_KEY: 'sk-test-not-a-key',
            OPENAI_BASE_URL: `http://127.0.0.1:${fake.address().port}/v1`},
    })
    p.stdout.on('data', d => { log += d })
    p.stderr.on('data', d => { log += d })
    p.log = () => log
    const until = Date.now() + 60000 // ts-node compiles on start
    while (!log.includes('Server started')) {
        if (Date.now() > until || p.exitCode !== null) throw new Error('app did not start:\n' + log)
        await new Promise(r => setTimeout(r, 100))
    }
    return p
}

test('page, init messages, chat round-trip through OpenAI (chat + TTS), mp3 served', async () => {
    const app = await startApp(3101)
    const base = 'http://127.0.0.1:3101'
    try {
        const page = await fetch(base + '/')
        assert.equal(page.status, 200)
        assert.match(await page.text(), /<html/i)

        const init = await (await fetch(base + '/chat/init')).json()
        assert.equal(init.length, 1)
        assert.equal(init[0].role, 'system')
        assert.match(init[0].content, /^Nous sommes dans une scéance de spiritisme/)

        reply = () => completion('whouuuuuuhuuuuuhuhuuuhuhuhuhuhuhuhuuuu, je suis Henri IV')
        calls.length = 0
        const messages = [...init, {role: 'user', content: 'Bonjour Henri'}]
        const r = await fetch(base + '/chat/send', {
            method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages}),
        })
        assert.equal(r.status, 200)
        assert.equal(await r.text(), 'whouuuuuuhuuuuuhuhuuuhuhuhuhuhuhuhuuuu, je suis Henri IV')

        assert.deepEqual(calls.map(c => `${c.method} ${c.url}`), ['POST /v1/chat/completions', 'POST /v1/audio/speech'])
        assert.equal(calls[0].auth, 'Bearer sk-test-not-a-key')
        assert.deepEqual(calls[0].body, {messages, model: 'gpt-4o-2024-05-13'})
        assert.deepEqual(calls[1].body, {voice: 'fable', model: 'tts-1', input: 'whouuuuuuhuuuuuhuhuuuhuhuhuhuhuhuhuuuu, je suis Henri IV'})

        const mp3 = await fetch(base + '/chat/complete/mp3/anything')
        assert.equal(mp3.status, 200)
        assert.deepEqual(Buffer.from(await mp3.arrayBuffer()), MP3)

        // An empty completion is voiced with the built-in apology.
        reply = () => completion(null)
        calls.length = 0
        await fetch(base + '/chat/send', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages})})
        assert.equal(calls[1].body.input, "Il semble que je n'ai pas de réponse à vous donner, je suis désolé.")
    } finally {
        app.kill()
        fs.rmSync(path.join(ROOT, 'tmp.mp3'), {force: true})
    }
})

test('known gap: an OpenAI error is not handled and takes the whole server down', async () => {
    const app = await startApp(3102)
    reply = () => ({status: 400, json: {error: {message: 'bad request', type: 'invalid_request_error'}}})
    const r = await fetch('http://127.0.0.1:3102/chat/send', {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({messages: []}),
    }).catch(e => e)
    assert.ok(r instanceof Error, 'no HTTP response: the process died')
    const code = app.exitCode ?? await new Promise(res => app.once('exit', res))
    assert.notEqual(code, 0)
    assert.match(app.log(), /BadRequestError|400/)
})
