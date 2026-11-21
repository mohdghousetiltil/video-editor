# Backend image for Railway: Node + ffmpeg (stitching, Shorts editing, captions) + yt-dlp (Shorts from links).
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates && rm -rf /var/lib/apt/lists/*
# yt-dlp standalone build; rebuild the image now and then to pick up site fixes
ADD https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
RUN chmod +x /usr/local/bin/yt-dlp
WORKDIR /app
COPY server.js shorts.js glitch.js ./
COPY lib ./lib
COPY routes ./routes
COPY public ./public
COPY fonts ./fonts
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 8080
CMD ["node", "server.js"]
