# Node application compiled from TypeScript (main.ts -> dist/main.js), served on :3000.
# Build stage: TypeScript 7 (native tsc, ships a static binary per platform, works on alpine/musl).
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216 AS build
WORKDIR /usr/src/app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json *.ts ./
RUN npm run build

# Runtime: production dependencies only, no compiler; nothing is compiled or cached at start.
FROM node:26.13.0-alpine@sha256:8996bb5821d62a8fd9bb27c1cb07462f3fdce6e47d640c6a881ead0b064ce216
WORKDIR /usr/src/app

# Exact dependency tree from the lockfile, without devDependencies (typescript, @types/*).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /usr/src/app/dist ./dist
COPY public ./public

# Unprivileged; the only runtime write is the answer mp3 in /tmp, so the rootfs can be read-only.
# The working directory stays /usr/src/app: express.static('public') and dotenv's .env resolve as before.
USER node
EXPOSE 3000

# Same as "npm start" (node dist/main.js) without npm at runtime.
CMD [ "node", "dist/main.js" ]
