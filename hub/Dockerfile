ARG NODE_IMAGE=node:22-alpine
FROM ${NODE_IMAGE}
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8797 CODEXY_HUB_CONFIG=/data/config.json CODEXY_WEB_ROOT=/app/web
COPY --chown=node:node hub/ ./hub/
COPY --chown=node:node relay/ ./relay/
COPY --chown=node:node vendor/ws/ ./node_modules/ws/
COPY --chown=node:node web/ ./web/
USER node
EXPOSE 8797
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD node -e "fetch('http://127.0.0.1:8797/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "hub/server.mjs"]
