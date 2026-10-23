# API + collaboration server. Build from the repository root:
#   docker build -f apps/server/Dockerfile -t collab-server .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/server --no-audit --no-fund
COPY apps/server apps/server
RUN npm run build -w apps/server

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/server --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/apps/server/dist apps/server/dist
WORKDIR /app/apps/server
USER node
# 4000: GraphQL + health/metrics, 1234: Yjs collaboration WebSocket
EXPOSE 4000 1234
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:4000/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
