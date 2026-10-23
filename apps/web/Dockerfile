# Static web app served by nginx, which also proxies the API and collaboration WebSocket so the
# browser talks to one origin. Build from the repository root:
#   docker build -f apps/web/Dockerfile -t collab-web .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace apps/web --no-audit --no-fund
COPY apps/web apps/web
# Same-origin paths, routed by nginx.conf. Override to point at another host.
ARG VITE_API_URL=/graphql
ARG VITE_COLLAB_URL=/collab
ENV VITE_API_URL=$VITE_API_URL VITE_COLLAB_URL=$VITE_COLLAB_URL
RUN npm run build -w apps/web

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz >/dev/null || exit 1
