# Gateway image for the existing shared-robot implementation. Build context: dsh-dingtalk/artifacts
# containing exactly one packed @wanyexin1998/dsh-dingtalk tarball.
FROM node:22-bookworm-slim
ARG PLUGIN_TARBALL=wanyexin1998-dsh-dingtalk-0.2.0-dev.12.tgz
RUN groupadd --gid 10002 gateway \
 && useradd --uid 10002 --gid 10002 --no-create-home --home-dir /var/lib/dsh-dingtalk-gateway --shell /usr/sbin/nologin gateway \
 && mkdir -p /var/lib/dsh-dingtalk-gateway /etc/dsh-dingtalk \
 && chown gateway:gateway /var/lib/dsh-dingtalk-gateway
COPY ${PLUGIN_TARBALL} /tmp/plugin.tgz
RUN npm install --global --omit=dev --ignore-scripts /tmp/plugin.tgz \
 && npm cache clean --force \
 && rm -f /tmp/plugin.tgz
USER 10002:10002
ENV NODE_ENV=production
WORKDIR /var/lib/dsh-dingtalk-gateway
ENTRYPOINT ["node", "/usr/local/lib/node_modules/@wanyexin1998/dsh-dingtalk/lib/bin.js", "gateway", "--config", "/etc/dsh-dingtalk/gateway.json"]
