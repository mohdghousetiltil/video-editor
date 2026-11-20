# Backend image for Railway: Node + ffmpeg (Story mode stitching, last-frame grabs, narration mixing).
FROM node:20-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
