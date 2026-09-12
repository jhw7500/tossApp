FROM node:24.21.0-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server/src ./src
COPY server/migrations ./migrations
COPY contracts /app/contracts
COPY deploy/pc-test/run.mjs /app/run.mjs
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "/app/run.mjs"]
CMD ["api"]
