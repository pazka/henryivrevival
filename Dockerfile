# ts-node application (main.ts), served on :3000.
FROM node:26-alpine

WORKDIR /usr/src/app

# Exact dependency tree from the lockfile (ts-node/typescript are needed at runtime).
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force

COPY . .

# Unprivileged; the only runtime write is the answer mp3 in /tmp, so the rootfs can be read-only.
USER node
EXPOSE 3000

# Same as "npm start" (ts-node main.ts) without npm at runtime.
CMD [ "node", "node_modules/ts-node/dist/bin.js", "main.ts" ]
