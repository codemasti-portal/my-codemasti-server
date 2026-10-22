# CodeMasti API — production image
# Node 22 LTS (mongoose 9 requires Node >= 20.19)
FROM node:22-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=5001

# Install prod dependencies first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Local uploads (avatars, staff images/resumes) — mount a volume here to persist
RUN mkdir -p uploads && chown -R node:node /app
USER node

EXPOSE 5001

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
