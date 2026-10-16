# Local multi-bot runner. Build from the repo root:
#   docker compose up --build
FROM node:22-bookworm-slim
WORKDIR /app
COPY engine /app/engine
COPY harness/package.json /app/harness/package.json
COPY harness/src /app/harness/src
COPY harness/scripts /app/harness/scripts
COPY harness/data /app/harness/data
# package.json is copied above; install the file: dependency on ../engine.
RUN cd harness && npm install --omit=dev
WORKDIR /app/harness
ENV NODE_ENV=production \
    MAFIOSO_LLM=lmstudio \
    LM_STUDIO_BASE_URL=http://host.docker.internal:1234/v1 \
    DEV_API_BASE_URL=https://dev.ultimafia.gg \
    BOT_COUNT=9
CMD ["node", "scripts/live.mjs"]
