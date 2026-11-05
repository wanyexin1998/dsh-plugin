# syntax=docker/dockerfile:1
# Standalone server-side DWS Connector image (Issue #24).
# Build context: dsh-dingtalk/  ->  docker build -f connector/docker/Dockerfile -t dsh-dingtalk-connector:<tag> .
# The pinned official DWS linux-amd64 artifact is verified twice: archive SHA256, then the single
# extracted binary SHA256. The build fails on any mismatch and never downloads at runtime.
# The build stage uses Node only (no apt/curl): the install script validates, extracts and executes
# `dws --version` against the pinned version and commit.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG DWS_VERSION=1.0.66
ARG DWS_COMMIT=f215043e676d6889e1ddce3464828d8b1ec40c31
ARG DWS_ARCHIVE_URL=https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli/releases/download/v1.0.66/dws-linux-amd64.tar.gz
ARG DWS_ARCHIVE_SHA256=27cd2821e1f6523d1eeaf5688c23502bddbdd858cf82e32c197853065418bef8
ARG DWS_BINARY_SHA256=4ee71b2e1d1d4b888dd41dbda6193d213636971196f0641d4ef1c74d12b49607

FROM ${NODE_IMAGE} AS dws-artifact
ARG DWS_VERSION
ARG DWS_COMMIT
ARG DWS_ARCHIVE_URL
ARG DWS_ARCHIVE_SHA256
ARG DWS_BINARY_SHA256
COPY connector/docker/verify-dws-artifact.mjs /tmp/verify-dws-artifact.mjs
RUN node /tmp/verify-dws-artifact.mjs \
      --url "${DWS_ARCHIVE_URL}" \
      --archive-sha256 "${DWS_ARCHIVE_SHA256}" \
      --binary-sha256 "${DWS_BINARY_SHA256}" \
      --version "${DWS_VERSION}" \
      --commit "${DWS_COMMIT}" \
      --output /opt/dws/bin/dws

FROM ${NODE_IMAGE} AS runtime
ARG DWS_VERSION
LABEL org.opencontainers.image.title="dsh-dingtalk-connector" \
      org.opencontainers.image.description="Standalone server-side DWS Connector for @wanyexin1998/dsh-dingtalk" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.dws.version="${DWS_VERSION}"
RUN groupadd --gid 10001 connector \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin connector
COPY --from=dws-artifact --chown=root:root --chmod=0555 /opt/dws/bin/dws /opt/dws/bin/dws
WORKDIR /app
COPY --chown=root:root connector/lib ./lib
COPY --chown=root:root connector/version.json ./version.json
COPY --chown=root:root enhancements/dws.lock.json ./dws.lock.json
ENV NODE_ENV=production \
    DSH_DINGTALK_DWS_LOCK=/app/dws.lock.json \
    DSH_CONNECTOR_DWS_BINARY=/opt/dws/bin/dws \
    DSH_CONNECTOR_STATE_DIR=/var/lib/dsh-dingtalk-connector
RUN mkdir -p /var/lib/dsh-dingtalk-connector && chown connector:connector /var/lib/dsh-dingtalk-connector && chmod 0700 /var/lib/dsh-dingtalk-connector
VOLUME ["/var/lib/dsh-dingtalk-connector"]
USER 10001:10001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD ["node", "/app/lib/main.mjs", "health"]
ENTRYPOINT ["node", "/app/lib/main.mjs"]
CMD ["serve"]
