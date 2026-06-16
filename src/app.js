import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { env } from './config/env.js';
import { closeMcpClient } from './mcp/mcpClient.js';
import { rateLimiter } from './middleware/rateLimiter.js';
import { errorHandler } from './middleware/errorHandler.js';
import powerbiRouter from './routes/powerbi.routes.js';
import migrationRouter from './routes/migration.routes.js';

const app = express();

// Secure HTTP headers
app.use(helmet());

// Configure CORS
app.use(cors({
  origin: env.frontendUrl,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

// Request/response logging
if (env.nodeEnv === 'production') {
  app.use(morgan('combined'));
} else {
  app.use(morgan('dev'));
}

// Body parsing middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health Check Endpoint
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    env: env.nodeEnv
  });
});

// Mount routes with rate limiting
app.use('/api/powerbi', rateLimiter, powerbiRouter);
app.use('/api/migration', rateLimiter, migrationRouter);

// Global Error Handler
app.use(errorHandler);

// Start the server
const server = app.listen(env.port, () => {
  console.log(`[SERVER] Node.js Express server running in ${env.nodeEnv} mode on port ${env.port}`);
  console.log(`[SERVER] CORS allowed origin: ${env.frontendUrl}`);
});

// Graceful shutdown handlers
const gracefulShutdown = () => {
  console.log('[SERVER] Shutdown signal received. Cleaning up resources...');
  closeMcpClient()
    .catch((err) => console.error('[SERVER] Error closing MCP client on shutdown:', err))
    .finally(() => {
      server.close(() => {
        console.log('[SERVER] HTTP server closed. Exit.');
        process.exit(0);
      });
    });
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

export default app;
export { server };
