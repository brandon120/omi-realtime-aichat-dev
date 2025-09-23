'use strict';

const path = require('path');
const { logger } = require('../services/logger');

/**
 * Centralized configuration management
 * Validates and provides all application configuration
 */
class Config {
  constructor() {
    this.env = process.env.NODE_ENV || 'development';
    this.isDevelopment = this.env === 'development';
    this.isProduction = this.env === 'production';
    
    // Load and validate configuration
    this.config = this.loadConfig();
    this.validateConfig();
    
    // Log configuration status
    logger.info('Configuration loaded', {
      environment: this.env,
      features: this.getEnabledFeatures()
    });
  }
  
  loadConfig() {
    return {
      // Server Configuration
      server: {
        port: this.getNumber('PORT', 3000),
        host: this.getString('HOST', '0.0.0.0'),
        trustProxy: this.getBoolean('TRUST_PROXY', false),
        sessionSecret: this.getString('SESSION_SECRET', this.generateDefaultSecret()),
        cookieSecure: this.isProduction
      },
      
      // Database Configuration
      database: {
        url: this.getString('DATABASE_URL', ''),
        // Auto-enable user system if DATABASE_URL is provided, or use explicit setting
        enableUserSystem: this.getBoolean('ENABLE_USER_SYSTEM', !!this.getString('DATABASE_URL', '')),
        maxConnections: this.getNumber('DB_MAX_CONNECTIONS', 10),
        connectionTimeout: this.getNumber('DB_CONNECTION_TIMEOUT', 30000),
        enableLogging: this.getBoolean('DB_ENABLE_LOGGING', this.isDevelopment)
      },
      
      // OpenAI Configuration
    openai: {
      apiKey: this.getString('OPENAI_API_KEY') || this.getString('OPENAI_KEY', ''),
      model: this.getString('OPENAI_MODEL', 'gpt-4o-mini'), // Note: gpt-5 models mentioned in docs are not yet available
      maxTokens: this.getNumber('OPENAI_MAX_TOKENS', 500),
      temperature: this.getNumber('OPENAI_TEMPERATURE', 0.7),
      timeout: this.getNumber('OPENAI_TIMEOUT', 20000),
      conversationState: {
        enabled: this.getBoolean('OPENAI_CONVERSATION_STATE', true),
        storeResponses: this.getBoolean('OPENAI_STORE_RESPONSES', true),
        maxContextTokens: this.getNumber('OPENAI_MAX_CONTEXT_TOKENS', 1000), // Increased for better context
        webhookMaxTokens: this.getNumber('OPENAI_WEBHOOK_MAX_TOKENS', 500), // Increased for better responses
        webhookTimeout: this.getNumber('OPENAI_WEBHOOK_TIMEOUT', 8000),
        includeHistory: this.getBoolean('OPENAI_INCLUDE_HISTORY', true), // Include conversation history
        historyMessages: this.getNumber('OPENAI_HISTORY_MESSAGES', 10) // Number of messages to include
      }
    },
      
      // OMI Integration
      omi: {
        appId: this.getString('OMI_APP_ID', ''),
        appSecret: this.getString('OMI_APP_SECRET', ''),
        apiUrl: this.getString('OMI_API_URL', 'https://api.omi.me'),
        webhookTimeout: this.getNumber('OMI_WEBHOOK_TIMEOUT', 25000)
      },
      
      // CORS Configuration
      cors: {
        origins: this.getStringArray('CORS_ORIGINS', [
          'http://localhost:8081',
          'http://localhost:19006',
          'http://localhost:3000',
          'http://127.0.0.1:3000',
          'https://omi-ai-realtime-chat-app.netlify.app'
        ]),
        patterns: this.getStringArray('CORS_ORIGIN_PATTERNS', []),
        credentials: true,
        maxAge: this.getNumber('CORS_MAX_AGE', 86400)
      },
      
      // Feature Flags
      features: {
        contextActivation: this.getBoolean('ENABLE_CONTEXT_ACTIVATION', true),
        newOmiRoutes: this.getBoolean('ENABLE_NEW_OMI_ROUTES', true),
        promptWorkers: this.getBoolean('ENABLE_PROMPT_WORKERS', true),
        quietHours: this.getBoolean('QUIET_HOURS_ENABLED', true),
        typedNotifications: this.getBoolean('SEND_TYPED_OMI_NOTIFICATIONS', false),
        backgroundQueue: this.getBoolean('ENABLE_BACKGROUND_QUEUE', true),
        caching: this.getBoolean('ENABLE_CACHING', true),
        rateLimit: this.getBoolean('ENABLE_RATE_LIMIT', true)
      },
      
      // Logging Configuration
      logging: {
        level: this.getString('LOG_LEVEL', this.isDevelopment ? 'debug' : 'info'),
        enableFile: this.getBoolean('ENABLE_FILE_LOGGING', this.isProduction),
        logDir: this.getString('LOG_DIR', path.join(process.cwd(), 'logs')),
        maxFileSize: this.getNumber('LOG_MAX_FILE_SIZE', 10 * 1024 * 1024),
        enableMetrics: this.getBoolean('ENABLE_METRICS', true)
      },
      
      // Performance Configuration
      performance: {
        slowRequestThreshold: this.getNumber('SLOW_REQUEST_THRESHOLD', 1000),
        requestTimeout: this.getNumber('REQUEST_TIMEOUT', 30000),
        maxRequestSize: this.getString('MAX_REQUEST_SIZE', '10mb'),
        compression: this.getBoolean('ENABLE_COMPRESSION', true)
      },
      
      // Queue Configuration
      queue: {
        batchSize: this.getNumber('QUEUE_BATCH_SIZE', 50),
        processingInterval: this.getNumber('QUEUE_PROCESSING_INTERVAL', 50),
        maxConcurrentJobs: this.getNumber('QUEUE_MAX_CONCURRENT_JOBS', 10),
        maxRetries: this.getNumber('QUEUE_MAX_RETRIES', 3)
      },
      
      // Cache Configuration
      cache: {
        ttl: this.getNumber('CACHE_TTL', 5 * 60 * 1000),
        maxSize: this.getNumber('CACHE_MAX_SIZE', 1000),
        checkPeriod: this.getNumber('CACHE_CHECK_PERIOD', 60 * 1000)
      },
      
      // Rate Limiting
      rateLimit: {
        windowMs: this.getNumber('RATE_LIMIT_WINDOW', 60 * 1000),
        maxRequests: this.getNumber('RATE_LIMIT_MAX_REQUESTS', 100),
        skipSuccessfulRequests: this.getBoolean('RATE_LIMIT_SKIP_SUCCESSFUL', false)
      },
      
      // Security Configuration
      security: {
        enableHelmet: this.getBoolean('ENABLE_HELMET', true),
        enableCsrf: this.getBoolean('ENABLE_CSRF', false),
        bcryptRounds: this.getNumber('BCRYPT_ROUNDS', 10),
        jwtSecret: this.getString('JWT_SECRET', this.generateDefaultSecret()),
        jwtExpiry: this.getString('JWT_EXPIRY', '24h')
      },
      
      // User Preferences Defaults
      userDefaults: {
        listenMode: this.getString('DEFAULT_LISTEN_MODE', 'TRIGGER'),
        followupWindowMs: this.getNumber('DEFAULT_FOLLOWUP_WINDOW', 8000),
        quietHoursStart: this.getNumber('DEFAULT_QUIET_HOURS_START', 22),
        quietHoursEnd: this.getNumber('DEFAULT_QUIET_HOURS_END', 8),
        activationRegex: this.getString('DEFAULT_ACTIVATION_REGEX', '')
      }
    };
  }
  
  // Helper methods for environment variable parsing
  getString(key, defaultValue = '') {
    return process.env[key] || defaultValue;
  }
  
  getNumber(key, defaultValue = 0) {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    const parsed = Number(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  
  getBoolean(key, defaultValue = false) {
    const value = process.env[key];
    if (value === undefined) return defaultValue;
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }
  
  getStringArray(key, defaultValue = []) {
    const value = process.env[key];
    if (!value) return defaultValue;
    return value.split(',').map(s => s.trim()).filter(Boolean);
  }
  
  generateDefaultSecret() {
    // Generate a default secret for development
    // In production, this should always be overridden
    const secret = require('crypto').randomBytes(32).toString('hex');
    if (this.isProduction) {
      logger.warn('Using generated secret - please set SESSION_SECRET and JWT_SECRET in production');
    }
    return secret;
  }
  
  validateConfig() {
    const errors = [];
    const warnings = [];
    
    // Required configurations in production
    if (this.isProduction) {
      if (!this.config.server.sessionSecret || this.config.server.sessionSecret.length < 32) {
        errors.push('SESSION_SECRET must be set and at least 32 characters in production');
      }
      
      if (!this.config.security.jwtSecret || this.config.security.jwtSecret.length < 32) {
        errors.push('JWT_SECRET must be set and at least 32 characters in production');
      }
      
      if (!this.config.openai.apiKey) {
        errors.push('OPENAI_API_KEY is required');
      }
    }
    
    // Warnings for recommended configurations
    if (this.config.features.contextActivation && !this.config.features.backgroundQueue) {
      warnings.push('Background queue is recommended when context activation is enabled');
    }
    
    if (this.config.database.enableUserSystem && !this.config.database.url) {
      errors.push('DATABASE_URL is required when user system is enabled');
    }
    
    if (this.config.omi.appId && !this.config.omi.appSecret) {
      warnings.push('OMI_APP_SECRET should be set when OMI_APP_ID is configured');
    }
    
    // Log validation results
    if (errors.length > 0) {
      errors.forEach(error => logger.error('Configuration error', { error }));
      throw new Error(`Configuration validation failed: ${errors.join(', ')}`);
    }
    
    if (warnings.length > 0) {
      warnings.forEach(warning => logger.warn('Configuration warning', { warning }));
    }
  }
  
  getEnabledFeatures() {
    return Object.entries(this.config.features)
      .filter(([_, enabled]) => enabled)
      .map(([feature]) => feature);
  }
  
  // Get specific configuration sections
  get(section) {
    return this.config[section];
  }
  
  // Get nested configuration value
  getValue(path, defaultValue) {
    const keys = path.split('.');
    let value = this.config;
    
    for (const key of keys) {
      if (value && typeof value === 'object' && key in value) {
        value = value[key];
      } else {
        return defaultValue;
      }
    }
    
    return value;
  }
  
  // Check if a feature is enabled
  isFeatureEnabled(feature) {
    return this.config.features[feature] === true;
  }
  
  // Export configuration for debugging (with sensitive data redacted)
  export() {
    const exported = JSON.parse(JSON.stringify(this.config));
    
    // Redact sensitive information
    if (exported.openai.apiKey) exported.openai.apiKey = '[REDACTED]';
    if (exported.omi.appSecret) exported.omi.appSecret = '[REDACTED]';
    if (exported.server.sessionSecret) exported.server.sessionSecret = '[REDACTED]';
    if (exported.security.jwtSecret) exported.security.jwtSecret = '[REDACTED]';
    if (exported.database.url) exported.database.url = '[REDACTED]';
    
    return exported;
  }
  
  // Display configuration summary
  displaySummary() {
    console.log('\n' + '='.repeat(80));
    console.log('CONFIGURATION SUMMARY');
    console.log('='.repeat(80));
    
    console.log('\n📋 Environment:', this.env);
    console.log('🚀 Server:', `${this.config.server.host}:${this.config.server.port}`);
    console.log('🔧 Features:', this.getEnabledFeatures().join(', '));
    console.log('📊 Logging Level:', this.config.logging.level);
    console.log('🗄️ Database:', this.config.database.enableUserSystem ? 'Enabled' : 'Disabled');
    console.log('🤖 OpenAI Model:', this.config.openai.model);
    
    if (this.isDevelopment) {
      console.log('\n⚠️  Development mode - some security features may be relaxed');
    }
    
    console.log('='.repeat(80) + '\n');
  }
}

// Create and export singleton instance
const config = new Config();
module.exports = config;