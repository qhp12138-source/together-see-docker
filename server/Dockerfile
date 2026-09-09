FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS deps
WORKDIR /app

ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_PROGRESS=false

COPY .npmrc ./
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm config get registry \
    && npm ci --include=dev --no-audit --no-fund --no-progress

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    NPM_CONFIG_REGISTRY=https://registry.npmmirror.com \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_PROGRESS=false

COPY .npmrc ./
COPY package.json package-lock.json ./
RUN npm config set registry https://registry.npmmirror.com \
    && npm config get registry \
    && npm ci --omit=dev --no-audit --no-fund --no-progress \
    && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY .env.example ./.env.example
COPY LICENSE ./LICENSE
EXPOSE 3000
CMD ["node", "dist/server.js"]
