# syntax=docker/dockerfile:1

# ---- deps: install production dependencies only ----
FROM node:26-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci --omit=dev --ignore-scripts

# ---- runtime: minimal image with application sources ----
FROM node:26-alpine AS runtime

ENV NODE_ENV=production
ENV PORT=3000

WORKDIR /app

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=deps --chown=node:node /app/package.json ./package.json

COPY --chown=node:node server.ts ./
COPY --chown=node:node logic ./logic
COPY --chown=node:node types ./types

# Ensure the default data file exists and is writable when no volume is mounted.
RUN touch /app/todo.txt && chown node:node /app/todo.txt /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.ts"]
