# Seoul RAIM (EN) — production image
#
# NOTE: the app refuses to boot in production without SESSION_SECRET set
# (see src/app.js) — the built-in fallback secret is public (checked into
# git) and would let anyone forge session cookies. Always pass SESSION_SECRET
# via `docker run -e` / `env_file` / your orchestrator's secret mechanism.

FROM node:26-slim

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App code.
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/

ENV NODE_ENV=production
ENV PORT=4310

EXPOSE 4310

# node:sqlite database + WAL files live here — mount a host path or named
# volume so data survives container recreation.
VOLUME /app/data

CMD ["node", "src/app.js"]
