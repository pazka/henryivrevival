# Node application compiled from TypeScript (main.ts -> dist/main.js), served on :3000.
# Build stage: TypeScript 7 (native tsc, ships a static binary per platform, works on alpine/musl).
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS build
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json *.ts ./
RUN npm run build

# Runtime: production dependencies only, no compiler; nothing is compiled or cached at start.
FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5
WORKDIR /usr/src/app

# Exact dependency tree from the lockfile, without devDependencies (typescript, @types/*).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist
COPY public ./public
COPY check ./check

# Unprivileged (any uid works: the legacy box runs it as `node`, hosh-deploy as 10001); the only runtime write is the answer mp3 in /tmp, so the rootfs can be read-only.
# The working directory stays /usr/src/app: express.static('public') and dotenv's .env resolve as before.
USER node
# Port from env PORT (default 3000 = the legacy box compose; hosh-deploy's compose sets PORT=8000).
EXPOSE 3000

# GET /healthz on $PORT: key configured, static files present, temp dir writable (never calls OpenAI).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --start-interval=2s --retries=3 \
  CMD ["node", "/usr/src/app/check/healthcheck.js"]

# Same as "npm start" (node dist/main.js) without npm at runtime.
CMD [ "node", "dist/main.js" ]
