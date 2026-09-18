# build stage: compile the TypeScript sources to dist/
FROM node:20-slim AS build
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=false

COPY tsconfig.json ./
COPY src ./src
RUN yarn build

# production stage: copy only the compiled output and production deps
FROM node:20-slim AS production
ENV NODE_ENV=production
WORKDIR /app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile --production=true \
  && yarn cache clean

COPY --from=build /app/dist ./dist

# run as a non-root user
RUN useradd --create-home --uid 10001 proxyuser
USER proxyuser

EXPOSE 3000

CMD ["node", "dist/index.js", "--transport", "http", "--config", "/app/mcp.json", "--port", "3000"]
