'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const { logger } = require('./logger');
const config = require('../config/config');
const {
  requestTracking,
  errorHandler,
  performanceMonitoring,
  requestLogging,
  healthCheck,
  metricsDashboard
} = require('../middleware/requestTracking');

/**
 * Application Initializer
 * Handles all app setup and initialization in a structured way
 */
class AppInitializer {
  constructor() {
    this.app = express();
    this.prisma = null;
    this.openai = null;
    this.backgroundQueue = null;
  }
  
  async initialize() {
    logger.info('Starting application initialization');
    
    try {
      // Display configuration summary
      config.displaySummary();
      
      // Initialize database
      await this.initializeDatabase();
      
      // Initialize OpenAI
      this.initializeOpenAI();
      
      // Initialize background queue
      await this.initializeBackgroundQueue();
      
      // Setup middleware
      this.setupMiddleware();
      
      // Setup routes
      await this.setupRoutes();
      
      // Setup error handling (must be last)
      this.setupErrorHandling();
      
      logger.info('Application initialization completed successfully');
      
      // Display metrics dashboard info
      if (config.getValue('logging.enableMetrics')) {
        logger.info('Metrics dashboard available', {
          url: `http://localhost:${config.getValue('server.port')}/metrics-dashboard`
        });
      }
      
      return this.app;
    } catch (error) {
      logger.fatal('Application initialization failed', {
        error: error.message,
        stack: error.stack
      });
      throw error;
    }
  }
  
  async initializeDatabase() {
    if (!config.getValue('database.enableUserSystem')) {
      logger.info('User system disabled, skipping database initialization');
      return;
    }
    
    try {
      const { PrismaClient } = require('@prisma/client');
      this.prisma = new PrismaClient({
        log: config.getValue('database.enableLogging') ? ['query', 'info', 'warn', 'error'] : ['error'],
        datasources: {
          db: {
            url: config.getValue('database.url')
          }
        }
      });
      
      // Test database connection
      await this.prisma.$connect();
      
      // Setup Prisma logging
      if (config.getValue('database.enableLogging')) {
        this.prisma.$on('query', (e) => {
          logger.logQuery(e.query, e.params, e.duration);
        });
      }
      
      logger.info('Database initialized successfully');
    } catch (error) {
      logger.error('Database initialization failed', {
        error: error.message
      });
      
      if (config.isProduction) {
        throw error; // Fatal in production
      }
    }
  }
  
  initializeOpenAI() {
    const OpenAI = require('openai');
    const apiKey = config.getValue('openai.apiKey');
    
    if (!apiKey) {
      logger.warn('OpenAI API key not configured');
      return;
    }
    
    this.openai = new OpenAI({
      apiKey,
      timeout: config.getValue('openai.timeout'),
      maxRetries: 3
    });
    
    // Check what APIs are available
    const availableAPIs = {
      chatCompletions: !!(this.openai.chat && this.openai.chat.completions),
      responses: !!(this.openai.beta && this.openai.beta.responses),
      conversations: !!(this.openai.beta && this.openai.beta.conversations),
      // Legacy check for responses at root level
      responsesRoot: !!(this.openai.responses)
    };
    
    logger.info('OpenAI client initialized', {
      model: config.getValue('openai.model'),
      availableAPIs
    });
  }
  
  async initializeBackgroundQueue() {
    if (!config.isFeatureEnabled('backgroundQueue')) {
      logger.info('Background queue disabled');
      return;
    }
    
    const { BackgroundQueue } = require('./backgroundQueue');
    
    this.backgroundQueue = new BackgroundQueue({
      prisma: this.prisma
    });
    
    // Apply configuration
    this.backgroundQueue.batchSize = config.getValue('queue.batchSize');
    this.backgroundQueue.processingInterval = config.getValue('queue.processingInterval');
    this.backgroundQueue.maxConcurrentJobs = config.getValue('queue.maxConcurrentJobs');
    this.backgroundQueue.maxRetries = config.getValue('queue.maxRetries');
    
    // Start the queue
    this.backgroundQueue.start();
    
    logger.info('Background queue initialized and started');
  }
  
  setupMiddleware() {
    const app = this.app;
    
    // Trust proxy if configured
    if (config.getValue('server.trustProxy')) {
      app.set('trust proxy', true);
    }
    
    // Request tracking (must be first)
    app.use(requestTracking());
    
    // Performance monitoring
    app.use(performanceMonitoring({
      slowRequestThreshold: config.getValue('performance.slowRequestThreshold')
    }));
    
    // Health check endpoint
    app.use(healthCheck('/health'));
    
    // Metrics dashboard
    if (config.getValue('logging.enableMetrics')) {
      app.use(metricsDashboard('/metrics-dashboard'));
    }
    
    // Compression
    if (config.getValue('performance.compression')) {
      app.use(compression());
    }
    
    // Body parsing
    app.use(express.json({
      limit: config.getValue('performance.maxRequestSize')
    }));
    app.use(express.urlencoded({
      extended: true,
      limit: config.getValue('performance.maxRequestSize')
    }));
    
    // Cookie parsing
    if (config.getValue('database.enableUserSystem')) {
      app.use(cookieParser(config.getValue('server.sessionSecret')));
    }
    
    // CORS setup
    this.setupCORS();
    
    // Request logging
    if (config.getValue('logging.level') === 'debug') {
      app.use(requestLogging({
        logBody: true,
        logHeaders: true
      }));
    }
    
    // Security headers
    if (config.getValue('security.enableHelmet')) {
      const helmet = require('helmet');
      app.use(helmet());
    }
    
    logger.info('Middleware setup completed');
  }
  
  setupCORS() {
    const app = this.app;
    const corsConfig = config.get('cors');
    
    app.use((req, res, next) => {
      const origin = req.headers.origin;
      
      if (origin && this.isOriginAllowed(origin, corsConfig)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
      res.setHeader('Access-Control-Allow-Credentials', String(corsConfig.credentials));
      res.setHeader('Access-Control-Max-Age', String(corsConfig.maxAge));
      
      if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
      }
      
      next();
    });
  }
  
  isOriginAllowed(origin, corsConfig) {
    if (!origin) return false;
    if (corsConfig.origins.includes('*')) return true;
    if (corsConfig.origins.includes(origin)) return true;
    
    // Check patterns
    for (const pattern of corsConfig.patterns) {
      if (pattern.startsWith('https://*.')) {
        const suffix = pattern.replace('https://*.', 'https://');
        if (origin.endsWith(suffix)) return true;
      }
      if (pattern.startsWith('http://*.')) {
        const suffix = pattern.replace('http://*.', 'http://');
        if (origin.endsWith(suffix)) return true;
      }
    }
    
    return false;
  }
  
  async setupRoutes() {
    const app = this.app;
    
    // API info endpoint
    app.get('/api/info', (req, res) => {
      res.json({
        name: 'OMI Real-time AI Chat Backend',
        version: '2.0.0',
        environment: config.env,
        features: config.getEnabledFeatures(),
        timestamp: new Date().toISOString()
      });
    });
    
    // Setup OMI routes if enabled
    if (config.isFeatureEnabled('newOmiRoutes')) {
      const createOmiRoutes = require('../routes/omi');
      createOmiRoutes({
        app,
        prisma: this.prisma,
        openai: this.openai,
        OPENAI_MODEL: config.getValue('openai.model'),
        ENABLE_USER_SYSTEM: config.getValue('database.enableUserSystem'),
        backgroundQueue: this.backgroundQueue
      });
      logger.info('OMI routes initialized');
    }
    
    // Setup prompt routes if enabled
    if (config.isFeatureEnabled('promptWorkers')) {
      const createPromptRoutes = require('../routes/prompts');
      createPromptRoutes({
        app,
        prisma: this.prisma,
        openai: this.openai,
        OPENAI_MODEL: config.getValue('openai.model'),
        ENABLE_USER_SYSTEM: config.getValue('database.enableUserSystem')
      });
      logger.info('Prompt routes initialized');
    }
    
    // Setup realtime routes
    const createRealtimeRoutes = require('../routes/realtime');
    createRealtimeRoutes({
      app,
      prisma: this.prisma,
      openai: this.openai,
      config
    });
    logger.info('Realtime routes initialized');
    
    // Setup user routes if enabled
    if (config.getValue('database.enableUserSystem')) {
      const createUserRoutes = require('../routes/users');
      createUserRoutes({
        app,
        prisma: this.prisma,
        config
      });
      logger.info('User routes initialized');
      
      // Setup windows and linking routes
      const createWindowsRoutes = require('../routes/windows');
      createWindowsRoutes({
        app,
        prisma: this.prisma,
        config
      });
      logger.info('Windows and linking routes initialized');
    }
    
    // 404 handler
    app.use((req, res) => {
      res.status(404).json({
        error: 'Route not found',
        path: req.path,
        method: req.method,
        timestamp: new Date().toISOString()
      });
    });
    
    logger.info('Routes setup completed');
  }
  
  setupErrorHandling() {
    // Global error handler (must be last)
    this.app.use(errorHandler());
    
    // Unhandled rejection handler
    process.on('unhandledRejection', (reason, promise) => {
      logger.error('Unhandled Promise Rejection', {
        reason: reason?.message || reason,
        stack: reason?.stack
      });
    });
    
    // Uncaught exception handler
    process.on('uncaughtException', (error) => {
      logger.fatal('Uncaught Exception', {
        error: error.message,
        stack: error.stack
      });
      
      // Graceful shutdown
      this.shutdown(1);
    });
    
    // Graceful shutdown on signals
    process.on('SIGTERM', () => this.shutdown(0));
    process.on('SIGINT', () => this.shutdown(0));
    
    logger.info('Error handling setup completed');
  }
  
  async shutdown(exitCode = 0) {
    logger.info('Starting graceful shutdown');
    
    try {
      // Display final metrics
      logger.displayMetricsTable();
      
      // Close database connection
      if (this.prisma) {
        await this.prisma.$disconnect();
        logger.info('Database connection closed');
      }
      
      // Stop background queue
      if (this.backgroundQueue) {
        // Process remaining jobs with timeout
        const timeout = setTimeout(() => {
          logger.warn('Shutdown timeout reached, forcing exit');
          process.exit(exitCode);
        }, 10000);
        
        await this.backgroundQueue.processJobs();
        clearTimeout(timeout);
        logger.info('Background queue stopped');
      }
      
      logger.info('Graceful shutdown completed');
      process.exit(exitCode);
    } catch (error) {
      logger.error('Error during shutdown', {
        error: error.message
      });
      process.exit(1);
    }
  }
  
  // Get initialized components
  getComponents() {
    return {
      app: this.app,
      prisma: this.prisma,
      openai: this.openai,
      backgroundQueue: this.backgroundQueue,
      config,
      logger
    };
  }
}

module.exports = AppInitializer;