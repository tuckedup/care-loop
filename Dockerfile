# syntax=docker/dockerfile:1
# CareLoop container image (synthetic-data demo). No secret is ever copied or baked into a layer:
# keys arrive at run time as mounted secret files read by docker/entrypoint.sh.
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# Build stage doubles as the "tools" image (migrate, seed, eval): it keeps dev dependencies.
FROM deps AS tools
COPY . .
ENV NEXT_OUTPUT=standalone
RUN pnpm build \
 && chown -R node:node /app
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
ENTRYPOINT ["entrypoint.sh"]
CMD ["pnpm", "db:migrate"]

# Runtime image: only the traced standalone server, run as a non-root user.
FROM ${NODE_IMAGE} AS runner
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=tools --chown=node:node /app/.next/standalone ./
COPY --from=tools --chown=node:node /app/.next/static ./.next/static
COPY --from=tools --chown=node:node /app/evals/results ./evals/results
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/entrypoint.sh
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["entrypoint.sh"]
CMD ["node", "server.js"]
