#!/usr/bin/env node
'use strict';

/**
 * OMI Real-time AI Chat Backend - Main Server
 * 
 * This is the main entry point for the application.
 * All initialization and configuration is handled through modular components.
 * 
 * Features:
 * - Comprehensive logging with metrics dashboard
 * - Modular route organization
 * - Centralized error handling
 * - Background job processing
 * - Real-time webhook processing
 * - User authentication and preferences
 * - OpenAI integration
 * 
 * @author Brandon Monroe
 * @version 2.0.0
 */

require('dotenv').config();

const { logger } = require('./services/logger');
const AppInitializer = require('./services/appInitializer');
const config = require('./config/config');

// Application startup
async function startServer() {
  try {
    logger.info('Starting OMI Real-time AI Chat Backend', {
      version: '2.0.0',
      node: process.version,
      pid: process.pid
    });
    
    // Initialize application
    const initializer = new AppInitializer();
    const app = await initializer.initialize();
    
    // Get configured port
    const PORT = config.getValue('server.port');
    const HOST = config.getValue('server.host');
    
    // Start server
    const server = app.listen(PORT, HOST, () => {
      logger.info('Server started successfully', {
        url: `http://${HOST}:${PORT}`,
        environment: config.env,
        features: config.getEnabledFeatures()
      });
      
      // Display startup information
      console.log('\n' + '='.repeat(80));
      console.log('🚀 OMI REAL-TIME AI CHAT BACKEND');
      console.log('='.repeat(80));
      console.log(`📍 Server URL:        http://${HOST}:${PORT}`);
      console.log(`📊 Metrics Dashboard: http://${HOST}:${PORT}/metrics-dashboard`);
      console.log(`❤️  Health Check:     http://${HOST}:${PORT}/health`);
      console.log(`📝 API Info:         http://${HOST}:${PORT}/api/info`);
      console.log('='.repeat(80));
      console.log('✅ Server is ready to accept connections\n');
      
      // Display metrics table periodically in development
      if (config.getValue('env') === 'development') {
        setInterval(() => {
          logger.displayMetricsTable();
        }, 60000); // Every minute
      }
    });
    
    // Handle server errors
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.fatal(`Port ${PORT} is already in use`, { port: PORT });
      } else if (error.code === 'EACCES') {
        logger.fatal(`Permission denied to bind to port ${PORT}`, { port: PORT });
      } else {
        logger.fatal('Server error', {
          error: error.message,
          code: error.code
        });
      }
      process.exit(1);
    });
    
    // Track server connections for graceful shutdown
    const connections = new Set();
    server.on('connection', (conn) => {
      connections.add(conn);
      conn.on('close', () => connections.delete(conn));
    });
    
    // Graceful shutdown handler
    const shutdown = async (signal) => {
      logger.info(`Received ${signal}, starting graceful shutdown`);
      
      // Stop accepting new connections
      server.close(() => {
        logger.info('Server closed to new connections');
      });
      
      // Close existing connections
      for (const conn of connections) {
        conn.end();
      }
      
      // Force close after timeout
      setTimeout(() => {
        for (const conn of connections) {
          conn.destroy();
        }
      }, 5000);
      
      // Trigger app shutdown
      await initializer.shutdown(0);
    };
    
    // Register shutdown handlers
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
    
  } catch (error) {
    logger.fatal('Failed to start server', {
      error: error.message,
      stack: error.stack
    });
    process.exit(1);
  }
}

// Start the server
startServer().catch((error) => {
  console.error('Fatal error during startup:', error);
  process.exit(1);
});

// Export for testing
module.exports = { startServer };