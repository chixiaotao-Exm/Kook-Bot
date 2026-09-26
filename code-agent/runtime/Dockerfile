FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv git ffmpeg fontconfig fonts-noto-cjk ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY ai-bot/package.json ai-bot/package-lock.json /opt/deps/ai-bot/
COPY quota-dashboard/package.json quota-dashboard/package-lock.json /opt/deps/quota-dashboard/
COPY music-bot/package.json music-bot/package-lock.json /opt/deps/music-bot/
RUN cd /opt/deps/ai-bot && npm ci --omit=dev --no-audit --no-fund \
    && cd /opt/deps/quota-dashboard && npm ci --omit=dev --no-audit --no-fund \
    && cd /opt/deps/music-bot && npm ci --omit=dev --no-audit --no-fund
COPY music-bot/qq/requirements.lock.txt /opt/deps/qq-requirements.txt
RUN python3 -m venv /opt/python && /opt/python/bin/pip install --no-cache-dir -r /opt/deps/qq-requirements.txt
COPY code-agent/runtime/run-checks.py /usr/local/bin/run-checks
COPY code-agent/broker/projects.py /usr/local/bin/check-projects.py
# bridge-bot, ops-center and menu-bot use Node/Python standard libraries only. Their
# suites run from /input; the three dependency-bearing projects are pinned above.
RUN chmod 755 /usr/local/bin/run-checks
ENV PATH="/opt/python/bin:${PATH}" HOME=/tmp
WORKDIR /work
USER 1000:1000
