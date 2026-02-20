FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY digital-notice-board/client/package*.json ./
RUN npm ci
COPY digital-notice-board/client/ ./
RUN npm run build

FROM node:22-alpine AS app
WORKDIR /app/server
COPY digital-notice-board/server/package*.json ./
RUN npm ci --omit=dev
COPY digital-notice-board/server/ ./
COPY --from=client-build /app/client/dist /app/client/dist
ENV NODE_ENV=production
EXPOSE 5001
CMD ["npm", "start"]
