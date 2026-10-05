FROM ghcr.io/flaresolverr/flaresolverr@sha256:c80ae007ce2ccdcd217a12426e4f039ef763ff90738c808d38810c3e59323767

COPY --chown=flaresolverr:flaresolverr report_browser.py /app/report_browser.py
COPY --chown=flaresolverr:flaresolverr report_proxy.py /app/report_proxy.py
ENV LOG_LEVEL=warning LOG_HTML=false HOST=0.0.0.0 PORT=8191
# Inherit dumb-init and the unprivileged user from the pinned upstream image.
CMD ["/usr/local/bin/python", "-u", "/app/report_browser.py"]
