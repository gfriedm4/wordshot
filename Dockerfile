# Wordshot — small Node/Express server (engine proxy + scoring + leaderboard).
FROM node:20-slim

WORKDIR /app

# Install deps first for layer caching. resvg-js ships prebuilt linux binaries,
# so no extra system packages are needed.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Minify the hand-written client JS in place (source stays readable in git).
# npx fetches esbuild at build time; nothing is added to the runtime deps.
RUN npx -y esbuild public/app.js --minify --allow-overwrite --outfile=public/app.js

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000

# The leaderboard persists to /app/data — mount a volume there in the cluster so
# scores survive restarts and redeploys.
CMD ["node", "server.js"]
