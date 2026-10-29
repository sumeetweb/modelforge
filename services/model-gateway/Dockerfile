FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY services/model-gateway/package.json services/model-gateway/package.json
COPY infra/cdk/package.json infra/cdk/package.json
COPY services/console/package.json services/console/package.json
RUN npm ci
COPY services/model-gateway services/model-gateway
COPY services/console services/console
RUN npm run build -w @modelforge/console && npm run build -w @modelforge/gateway && npm prune --omit=dev --workspace=@modelforge/gateway
FROM node:22-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/services/model-gateway /app/services/model-gateway
COPY --from=build /app/services/console/dist /app/services/console/dist
USER node
EXPOSE 8080
CMD ["node", "services/model-gateway/dist/index.js"]
