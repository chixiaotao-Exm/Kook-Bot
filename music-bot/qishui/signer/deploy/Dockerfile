FROM debian:bookworm-slim
ENV DEBIAN_FRONTEND=noninteractive WINEPREFIX=/wine WINEDEBUG=-all WINEDLLOVERRIDES=mscoree,mshtml= \
    LIBMSSDK_BIND=0.0.0.0 LIBMSSDK_PORT=8899 LIBMSSDK_STATE_DIR=Z:\\state \
    LIBMSSDK_BDMS_MODULE=Z:\\client\\bdms.node
RUN dpkg --add-architecture i386 && apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip p7zip-full \
 && mkdir -pm755 /etc/apt/keyrings \
 && curl -fsSL -o /etc/apt/keyrings/winehq-archive.key https://dl.winehq.org/wine-builds/winehq.key \
 && curl -fsSL -o /etc/apt/sources.list.d/winehq-bookworm.sources https://dl.winehq.org/wine-builds/debian/dists/bookworm/winehq-bookworm.sources \
 && apt-get update && apt-get install -y --no-install-recommends winehq-stable \
 && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL --retry 2 -o /tmp/node.zip https://nodejs.org/dist/v20.18.0/node-v20.18.0-win-x64.zip \
 && echo 'f5cea43414cc33024bbe5867f208d1c9c915d6a38e92abeee07ed9e563662297  /tmp/node.zip' | sha256sum -c - \
 && unzip -q /tmp/node.zip -d /opt && mv /opt/node-v20.18.0-win-x64 /opt/node-win \
 && rm /tmp/node.zip
RUN groupadd -g 10001 signer && useradd -u 10001 -g 10001 -m signer \
 && mkdir /wine /state /client && chown -R signer:signer /wine /state
WORKDIR /app
COPY package.json LICENSE /app/
COPY src /app/src
COPY deploy/entrypoint.sh /app/entrypoint.sh
RUN chmod 755 /app/entrypoint.sh
USER 10001:10001
ENTRYPOINT ["/app/entrypoint.sh"]
