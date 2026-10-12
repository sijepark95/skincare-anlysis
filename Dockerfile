# Verified official multi-architecture image; update the tag and digest together.
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM base AS builder
COPY --from=dependencies /app/node_modules ./node_modules
COPY . .
# Public presentation values are build-time settings, never secrets.
ARG NEXT_PUBLIC_APP_URL=http://localhost:3000
ARG NEXT_PUBLIC_HERO_VIDEO_URL
ENV NODE_ENV=production \
    NEXT_OUTPUT_STANDALONE=1 \
    APP_MODE=demo \
    NEXT_PUBLIC_APP_URL=${NEXT_PUBLIC_APP_URL} \
    NEXT_PUBLIC_HERO_VIDEO_URL=${NEXT_PUBLIC_HERO_VIDEO_URL}
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production \
    HOSTNAME=0.0.0.0 \
    PORT=3000
RUN groupadd --gid 10001 senmiva \
    && useradd --uid 10001 --gid 10001 --no-create-home senmiva
COPY --from=builder --chown=10001:10001 /app/.next/standalone ./
COPY --from=builder --chown=10001:10001 /app/.next/static ./.next/static
COPY --from=builder --chown=10001:10001 /app/public ./public
RUN mkdir -p .next/cache .local && chown -R 10001:10001 .next/cache .local
USER 10001:10001
EXPOSE 3000
# Liveness only: external Auth/database readiness is validated separately.
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/v1/healthz',{signal:AbortSignal.timeout(2000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
