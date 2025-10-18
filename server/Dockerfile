FROM node:18-alpine as builder

# Build backend
WORKDIR /build-backend
COPY server/package.json server/package-lock.json* ./
RUN npm install --verbose
COPY server/src ./src

# Build frontend  
WORKDIR /build-frontend
COPY client/package.json ./
RUN npm install --verbose
COPY client ./
RUN npm run build || echo "Build output:" && ls -la

# Final stage
FROM node:18-alpine

WORKDIR /app

# Copy backend dependencies
COPY --from=builder /build-backend/package.json /build-backend/package-lock.json* ./
RUN npm install --production

# Copy backend source
COPY --from=builder /build-backend/src ./src

# Copy built frontend files to public
COPY --from=builder /build-frontend/dist ./public

# Create logs directory
RUN mkdir -p logs

# Expose port
EXPOSE 3001

# Start the application
CMD ["node", "src/index.js"]
