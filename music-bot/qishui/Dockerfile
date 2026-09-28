FROM node:22-bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* && groupadd -g 10003 qishuibot && useradd -u 10003 -g 10003 -m qishuibot
WORKDIR /app
COPY package.json /app/package.json
COPY src/util.js /app/src/util.js
COPY qishui /app/qishui
USER 10003:10003
ENV HOST=127.0.0.1 PORT=19095
CMD ["node","qishui/server.js"]
