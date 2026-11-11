FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js boards.js replays.js ./
# every module the server needs is in the image (a missing one fails the
# build here, not the revision's start: boards.js was left out once)
RUN node -e "require('./server.js')"
USER node
EXPOSE 8080
CMD ["node", "server.js"]
