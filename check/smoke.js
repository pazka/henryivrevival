// Capability smoke run INSIDE the container after each deploy (deploy/hosh-deploy.conf POST_DEPLOY; non-zero
// exit ⇒ hosh-deploy rolls back). Never calls OpenAI (it costs money): the paid route /chat/send is only probed
// with requests its guards refuse before anything reaches OpenAI. Node built-ins only.
//   node /usr/src/app/check/smoke.js http://127.0.0.1:8000
'use strict'
const base = (process.argv[2] || `http://127.0.0.1:${process.env.PORT || 3000}`).replace(/\/$/, '')
let failed = 0

async function check(name, fn) {
    try {
        await fn()
        console.log(`ok   ${name}`)
    } catch (e) {
        failed++
        console.log(`FAIL ${name}: ${e.message}`)
    }
}
function expect(cond, msg) { if (!cond) throw new Error(msg) }
const get = (p, init) => fetch(base + p, {signal: AbortSignal.timeout(5000), ...init})
const send = (body, headers = {}) => get('/chat/send', {method: 'POST', headers: {'content-type': 'application/json', ...headers}, body})

async function main() {
    await check('/healthz: key configured (not shown), static files, writable temp dir', async () => {
        const r = await get('/healthz')
        const text = await r.text()
        expect(r.status === 200, `status ${r.status}: ${text}`)
        const j = JSON.parse(text)
        expect(j.status === 'ok' && j.openai_key === true && j.static_files === true && j.tmp_writable === true, text)
        expect(!/sk-/.test(text) && !(process.env.OPENAI_API_KEY && text.includes(process.env.OPENAI_API_KEY)), 'key leaked')
    })
    await check('page', async () => {
        const r = await get('/')
        expect(r.status === 200, `status ${r.status}`)
        expect(/<html/i.test(await r.text()), 'not html')
    })
    for (const [p, type] of [['/sceance.mjs', 'javascript'], ['/speech.mjs', 'javascript'], ['/openai.mjs', 'javascript'],
        ['/henry.jpg', 'image/jpeg'], ['/scene.jpg', 'image/jpeg']]) {
        await check(`asset ${p}`, async () => {
            const r = await get(p)
            const body = await r.arrayBuffer()
            expect(r.status === 200 && body.byteLength > 0, `status ${r.status}, ${body.byteLength} bytes`)
            expect((r.headers.get('content-type') || '').includes(type), `content-type ${r.headers.get('content-type')}`)
        })
    }
    await check('/chat/init: the séance system prompt', async () => {
        const j = await (await get('/chat/init')).json()
        expect(Array.isArray(j) && j[0].role === 'system' && j[0].content.includes('Henri quatre'), JSON.stringify(j).slice(0, 100))
    })
    await check('POST /chat → 204', async () => {
        expect((await get('/chat', {method: 'POST'})).status === 204, 'not 204')
    })
    await check('mp3 route answers (200 or 404 before any answer), no 5xx', async () => {
        const r = await get('/chat/complete/mp3/x.mp3')
        expect(r.status === 200 || r.status === 404, `status ${r.status}`)
    })
    await check('/chat/send guards (nothing reaches OpenAI): bad body 400, foreign origin 403, 32 kB limit 413', async () => {
        const bad = await send('{"messages":"nope"}')
        expect(bad.status === 400 && (await bad.text()) === 'messages must be an array', `bad body: ${bad.status}`)
        const foreign = await send('{"messages":"nope"}', {origin: 'https://other.example'})
        expect(foreign.status === 403, `foreign origin: ${foreign.status}`)
        const huge = await send(JSON.stringify({messages: 'x'.repeat(40000)}))
        expect(huge.status === 413, `huge body: ${huge.status}`)
    })
    await check('dotfiles are not served', async () => {
        expect((await get('/.env')).status === 404, 'GET /.env not 404')
    })
    console.log(failed ? `SMOKE FAILED (${failed})` : `SMOKE OK ${base}`)
    process.exit(failed ? 1 : 0)
}
main().catch(e => { console.log('SMOKE ERROR', e.message); process.exit(1) })
