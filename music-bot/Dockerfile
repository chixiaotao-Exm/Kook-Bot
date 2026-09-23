ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE}
ARG APT_MIRROR=deb.debian.org
ARG NPM_REGISTRY=https://registry.npmjs.org
ARG PIP_INDEX_URL=https://pypi.org/simple
RUN sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --registry=${NPM_REGISTRY} \
    && npm cache clean --force
COPY src ./src
COPY scripts ./scripts
COPY web ./web
COPY qq ./qq
RUN python3 -m venv /opt/qq-venv \
    && /opt/qq-venv/bin/pip install --no-cache-dir --index-url ${PIP_INDEX_URL} -r qq/requirements.lock.txt
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production DATA_DIR=/app/data DOTENV_CONFIG_QUIET=true QQ_PYTHON_PATH=/opt/qq-venv/bin/python3
USER node
STOPSIGNAL SIGTERM
CMD ["node", "src/index.js"]
