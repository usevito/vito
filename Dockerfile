# Vito - Security proxy for MCP servers

FROM node:20-slim

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY package.json package-lock.json* ./

# Install dependencies
RUN npm ci --only=production=false

# Copy source files and configuration
COPY tsconfig.json ./
COPY rules.json ./
COPY src/ ./src/

# Build the TypeScript project
RUN npm run build

# Create logs directory
RUN mkdir -p logs

# Expose Dashboard port
EXPOSE 3000

# Health check for the dashboard
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:3000/api/stats || exit 1

# Set environment variables
ENV NODE_ENV=production

# Default command
CMD ["npm", "start"]
