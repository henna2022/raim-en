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

# App code. scripts/ is included so the documented backup procedure
# (docs/DEPLOY.md ⑦) can run inside the container.
COPY src/ ./src/
COPY views/ ./views/
COPY public/ ./public/
COPY scripts/ ./scripts/

ENV NODE_ENV=production
ENV PORT=4310
# Inside the container the listener must accept the port mapping, so it binds
# all interfaces here. Exposure is constrained on the HOST side instead:
# docker-compose publishes to 127.0.0.1 only. Outside Docker the app defaults
# to binding loopback (src/app.js).
ENV HOST=0.0.0.0

EXPOSE 4310

# node:sqlite database + WAL files live here — mount a host path or named
# volume so data survives container recreation.
VOLUME /app/data

CMD ["node", "src/app.js"]
