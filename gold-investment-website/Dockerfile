# Portable container image for Aparanji — deploy on any container host
# (Fly.io, Railway, Cloud Run, a VPS, etc.). Mount a volume at /data.
FROM node:20-slim

WORKDIR /app

# Install production dependencies first (better layer caching)
COPY package*.json ./
RUN npm install --omit=dev

# App source
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3000
EXPOSE 3000

# Persist customer data / KYC / PDFs on a mounted volume
VOLUME ["/data"]

CMD ["node", "server.js"]
