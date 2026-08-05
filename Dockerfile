# build v4
FROM node:20-alpine
ARG NO_CACHE

WORKDIR /app

# Install backend deps
COPY backend/package*.json ./backend/
RUN cd backend && npm install --production

# Install frontend deps and build (unset NODE_ENV so devDeps install)
COPY frontend/package*.json ./frontend/
RUN cd frontend && npm install

COPY frontend/ ./frontend/
RUN cd frontend && npm run build

# Copy backend source
COPY backend/ ./backend/

# Serve frontend build from backend
ENV NODE_ENV=production
EXPOSE 3001

CMD ["node", "backend/server.js"]
