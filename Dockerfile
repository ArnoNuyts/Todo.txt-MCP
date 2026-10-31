FROM node:24-alpine

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --chown=node:node server.ts ./
COPY --chown=node:node logic ./logic
COPY --chown=node:node types ./types

USER node

EXPOSE 3000

CMD ["node", "server.ts"]
