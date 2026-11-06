// Container healthcheck (image HEALTHCHECK and docker-compose.example.yml): GET /healthz on the port the
// server listens on (PORT, default 3000) must answer 200 {"status":"ok"}. Node built-ins only, no shell needed.
'use strict'
const url = `http://127.0.0.1:${process.env.PORT || 3000}/healthz`
fetch(url, {signal: AbortSignal.timeout(4000)})
    .then(async r => process.exit(r.status === 200 && (await r.json()).status === 'ok' ? 0 : 1))
    .catch(() => process.exit(1))
