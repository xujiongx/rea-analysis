FROM node:24.22.1-bookworm-slim
ENV MCP_HOST=0.0.0.0
ENV MCP_PORT=18765
RUN apt-get update && apt-get install -y --no-install-recommends python3 && rm -rf /var/lib/apt/lists/*
RUN npm install -g --ignore-scripts --no-fund --no-audit rea-agents@6.8.0
COPY --chown=node:node manifest.json evidence.json /env/
USER node
CMD ["rea","environment-serve","/env/manifest.json","--evidence","/env/evidence.json"]
