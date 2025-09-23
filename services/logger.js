'use strict';

const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

/**
 * Comprehensive logging system with structured logging and table display
 * Features:
 * - Multiple log levels (debug, info, warn, error)
 * - Structured logging with metadata
 * - Request/response logging
 * - Performance tracking
 * - Table formatting for troubleshooting
 * - File and console output
 * - Log rotation support
 */
class Logger {
  constructor(options = {}) {
    this.level = options.level || process.env.LOG_LEVEL || 'info';
    this.name = options.name || 'app';
    this.enableConsole = options.console !== false;
    this.enableFile = options.file || false;
    this.logDir = options.logDir || path.join(process.cwd(), 'logs');
    this.maxFileSize = options.maxFileSize || 10 * 1024 * 1024; // 10MB
    this.enableTableOutput = options.tableOutput !== false;
    this.requestMetrics = new Map();
    this.systemMetrics = {
      requests: { total: 0, success: 0, failed: 0 },
      performance: { avgResponseTime: 0, maxResponseTime: 0, minResponseTime: Infinity },
      errors: { total: 0, byType: {} },
      webhooks: { processed: 0, failed: 0, avgProcessingTime: 0 },
      database: { queries: 0, errors: 0, avgQueryTime: 0 },
      cache: { hits: 0, misses: 0, hitRate: 0 },
      queue: { enqueued: 0, processed: 0, failed: 0, avgProcessingTime: 0 }
    };
    
    // Log levels
    this.levels = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
      fatal: 4
    };
    
    // Colors for console output
    this.colors = {
      debug: '\x1b[36m',  // Cyan
      info: '\x1b[32m',   // Green
      warn: '\x1b[33m',   // Yellow
      error: '\x1b[31m',  // Red
      fatal: '\x1b[35m',  // Magenta
      reset: '\x1b[0m'
    };
    
    // Initialize file logging if enabled
    if (this.enableFile) {
      this.initializeFileLogging();
    }
    
    // Start metrics collection
    this.startMetricsCollection();
  }
  
  initializeFileLogging() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
    this.currentLogFile = path.join(this.logDir, `${this.name}-${new Date().toISOString().split('T')[0]}.log`);
  }
  
  startMetricsCollection() {
    // Collect system metrics every 30 seconds
    setInterval(() => {
      this.calculateMetrics();
    }, 30000);
  }
  
  calculateMetrics() {
    // Calculate average response times
    const responseTimes = Array.from(this.requestMetrics.values())
      .filter(m => m.endTime)
      .map(m => m.endTime - m.startTime);
    
    if (responseTimes.length > 0) {
      this.systemMetrics.performance.avgResponseTime = 
        responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
      this.systemMetrics.performance.maxResponseTime = Math.max(...responseTimes);
      this.systemMetrics.performance.minResponseTime = Math.min(...responseTimes);
    }
    
    // Calculate cache hit rate
    const totalCacheAccess = this.systemMetrics.cache.hits + this.systemMetrics.cache.misses;
    if (totalCacheAccess > 0) {
      this.systemMetrics.cache.hitRate = 
        (this.systemMetrics.cache.hits / totalCacheAccess * 100).toFixed(2) + '%';
    }
    
    // Clean up old request metrics (keep last 1000)
    if (this.requestMetrics.size > 1000) {
      const entries = Array.from(this.requestMetrics.entries());
      const toKeep = entries.slice(-1000);
      this.requestMetrics = new Map(toKeep);
    }
  }
  
  shouldLog(level) {
    return this.levels[level] >= this.levels[this.level];
  }
  
  formatMessage(level, message, metadata = {}) {
    const timestamp = new Date().toISOString();
    const formattedLevel = level.toUpperCase().padEnd(5);
    
    const logEntry = {
      timestamp,
      level: formattedLevel,
      name: this.name,
      message,
      ...metadata
    };
    
    // Console format with colors
    let consoleOutput = `${this.colors[level]}[${timestamp}] [${formattedLevel}] [${this.name}]${this.colors.reset} ${message}`;
    
    if (Object.keys(metadata).length > 0) {
      consoleOutput += ` ${JSON.stringify(metadata)}`;
    }
    
    // File format (JSON)
    const fileOutput = JSON.stringify(logEntry);
    
    return { consoleOutput, fileOutput, logEntry };
  }
  
  log(level, message, metadata = {}) {
    if (!this.shouldLog(level)) return;
    
    const { consoleOutput, fileOutput, logEntry } = this.formatMessage(level, message, metadata);
    
    // Console output
    if (this.enableConsole) {
      console.log(consoleOutput);
    }
    
    // File output
    if (this.enableFile) {
      this.writeToFile(fileOutput);
    }
    
    // Update error metrics
    if (level === 'error' || level === 'fatal') {
      this.systemMetrics.errors.total++;
      const errorType = metadata.type || 'unknown';
      this.systemMetrics.errors.byType[errorType] = 
        (this.systemMetrics.errors.byType[errorType] || 0) + 1;
    }
    
    return logEntry;
  }
  
  writeToFile(content) {
    try {
      fs.appendFileSync(this.currentLogFile, content + '\n');
      
      // Check file size for rotation
      const stats = fs.statSync(this.currentLogFile);
      if (stats.size > this.maxFileSize) {
        this.rotateLogFile();
      }
    } catch (error) {
      console.error('Failed to write to log file:', error);
    }
  }
  
  rotateLogFile() {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rotatedFile = path.join(this.logDir, `${this.name}-${timestamp}.log`);
    
    try {
      fs.renameSync(this.currentLogFile, rotatedFile);
      this.currentLogFile = path.join(this.logDir, `${this.name}-${new Date().toISOString().split('T')[0]}.log`);
    } catch (error) {
      console.error('Failed to rotate log file:', error);
    }
  }
  
  // Convenience methods
  debug(message, metadata) {
    return this.log('debug', message, metadata);
  }
  
  info(message, metadata) {
    return this.log('info', message, metadata);
  }
  
  warn(message, metadata) {
    return this.log('warn', message, metadata);
  }
  
  error(message, metadata) {
    return this.log('error', message, metadata);
  }
  
  fatal(message, metadata) {
    return this.log('fatal', message, metadata);
  }
  
  // Request tracking
  startRequest(requestId, req) {
    const metadata = {
      method: req.method,
      url: req.url,
      path: req.path,
      query: req.query,
      headers: {
        'user-agent': req.headers['user-agent'],
        'content-type': req.headers['content-type']
      },
      ip: req.ip || req.connection.remoteAddress,
      startTime: performance.now()
    };
    
    this.requestMetrics.set(requestId, metadata);
    this.systemMetrics.requests.total++;
    
    this.info(`Request started: ${req.method} ${req.path}`, {
      requestId,
      method: req.method,
      path: req.path
    });
  }
  
  endRequest(requestId, res, error = null) {
    const metadata = this.requestMetrics.get(requestId);
    if (!metadata) return;
    
    metadata.endTime = performance.now();
    metadata.duration = metadata.endTime - metadata.startTime;
    metadata.statusCode = res.statusCode;
    
    if (error) {
      metadata.error = error.message || error;
      this.systemMetrics.requests.failed++;
    } else {
      this.systemMetrics.requests.success++;
    }
    
    this.info(`Request completed: ${metadata.method} ${metadata.path}`, {
      requestId,
      duration: `${metadata.duration.toFixed(2)}ms`,
      statusCode: metadata.statusCode,
      error: error?.message
    });
  }
  
  // Database query logging
  logQuery(query, params, duration, error = null) {
    this.systemMetrics.database.queries++;
    
    const metadata = {
      query: query.substring(0, 200), // Truncate long queries
      params: params?.length || 0,
      duration: `${duration.toFixed(2)}ms`
    };
    
    if (error) {
      this.systemMetrics.database.errors++;
      this.error('Database query failed', { ...metadata, error: error.message });
    } else {
      // Update average query time
      const currentAvg = this.systemMetrics.database.avgQueryTime;
      const totalQueries = this.systemMetrics.database.queries;
      this.systemMetrics.database.avgQueryTime = 
        ((currentAvg * (totalQueries - 1)) + duration) / totalQueries;
      
      this.debug('Database query executed', metadata);
    }
  }
  
  // Webhook logging
  logWebhook(sessionId, action, data, duration, error = null) {
    const metadata = {
      sessionId,
      action,
      duration: duration ? `${duration.toFixed(2)}ms` : undefined,
      ...data
    };
    
    if (error) {
      this.systemMetrics.webhooks.failed++;
      this.error('Webhook processing failed', { ...metadata, error: error.message });
    } else {
      this.systemMetrics.webhooks.processed++;
      
      // Update average processing time
      if (duration) {
        const currentAvg = this.systemMetrics.webhooks.avgProcessingTime;
        const total = this.systemMetrics.webhooks.processed;
        this.systemMetrics.webhooks.avgProcessingTime = 
          ((currentAvg * (total - 1)) + duration) / total;
      }
      
      this.info('Webhook processed', metadata);
    }
  }
  
  // Queue logging
  logQueue(action, jobType, jobId, data = {}, error = null) {
    const metadata = {
      action,
      jobType,
      jobId,
      ...data
    };
    
    switch (action) {
      case 'enqueue':
        this.systemMetrics.queue.enqueued++;
        this.debug('Job enqueued', metadata);
        break;
      case 'process':
        this.systemMetrics.queue.processed++;
        this.debug('Job processed', metadata);
        break;
      case 'failed':
        this.systemMetrics.queue.failed++;
        this.error('Job failed', { ...metadata, error: error?.message });
        break;
      default:
        this.debug(`Queue action: ${action}`, metadata);
    }
  }
  
  // Cache logging
  logCache(action, key, hit = false) {
    if (hit) {
      this.systemMetrics.cache.hits++;
    } else {
      this.systemMetrics.cache.misses++;
    }
    
    this.debug(`Cache ${action}`, {
      key,
      hit,
      hitRate: this.systemMetrics.cache.hitRate
    });
  }
  
  // Display metrics table
  displayMetricsTable() {
    console.log('\n' + '='.repeat(80));
    console.log('SYSTEM METRICS DASHBOARD');
    console.log('='.repeat(80));
    
    // Request Metrics
    console.log('\n📊 REQUEST METRICS');
    console.table({
      'Total Requests': this.systemMetrics.requests.total,
      'Successful': this.systemMetrics.requests.success,
      'Failed': this.systemMetrics.requests.failed,
      'Success Rate': this.systemMetrics.requests.total > 0 
        ? `${(this.systemMetrics.requests.success / this.systemMetrics.requests.total * 100).toFixed(2)}%`
        : 'N/A'
    });
    
    // Performance Metrics
    console.log('\n⚡ PERFORMANCE METRICS');
    console.table({
      'Avg Response Time': `${this.systemMetrics.performance.avgResponseTime.toFixed(2)}ms`,
      'Max Response Time': `${this.systemMetrics.performance.maxResponseTime.toFixed(2)}ms`,
      'Min Response Time': this.systemMetrics.performance.minResponseTime === Infinity 
        ? 'N/A' 
        : `${this.systemMetrics.performance.minResponseTime.toFixed(2)}ms`
    });
    
    // Webhook Metrics
    console.log('\n🔗 WEBHOOK METRICS');
    console.table({
      'Processed': this.systemMetrics.webhooks.processed,
      'Failed': this.systemMetrics.webhooks.failed,
      'Avg Processing Time': `${this.systemMetrics.webhooks.avgProcessingTime.toFixed(2)}ms`
    });
    
    // Database Metrics
    console.log('\n💾 DATABASE METRICS');
    console.table({
      'Total Queries': this.systemMetrics.database.queries,
      'Failed Queries': this.systemMetrics.database.errors,
      'Avg Query Time': `${this.systemMetrics.database.avgQueryTime.toFixed(2)}ms`,
      'Error Rate': this.systemMetrics.database.queries > 0
        ? `${(this.systemMetrics.database.errors / this.systemMetrics.database.queries * 100).toFixed(2)}%`
        : 'N/A'
    });
    
    // Cache Metrics
    console.log('\n🗄️ CACHE METRICS');
    console.table({
      'Cache Hits': this.systemMetrics.cache.hits,
      'Cache Misses': this.systemMetrics.cache.misses,
      'Hit Rate': this.systemMetrics.cache.hitRate
    });
    
    // Queue Metrics
    console.log('\n📦 QUEUE METRICS');
    console.table({
      'Enqueued': this.systemMetrics.queue.enqueued,
      'Processed': this.systemMetrics.queue.processed,
      'Failed': this.systemMetrics.queue.failed,
      'Success Rate': this.systemMetrics.queue.processed > 0
        ? `${((this.systemMetrics.queue.processed - this.systemMetrics.queue.failed) / this.systemMetrics.queue.processed * 100).toFixed(2)}%`
        : 'N/A'
    });
    
    // Error Breakdown
    if (this.systemMetrics.errors.total > 0) {
      console.log('\n❌ ERROR BREAKDOWN');
      console.table(this.systemMetrics.errors.byType);
    }
    
    // Active Requests (last 10)
    const activeRequests = Array.from(this.requestMetrics.entries())
      .filter(([_, m]) => !m.endTime)
      .slice(-10)
      .map(([id, m]) => ({
        'Request ID': id.substring(0, 8),
        'Method': m.method,
        'Path': m.path,
        'Duration': `${(performance.now() - m.startTime).toFixed(0)}ms`
      }));
    
    if (activeRequests.length > 0) {
      console.log('\n🔄 ACTIVE REQUESTS');
      console.table(activeRequests);
    }
    
    console.log('\n' + '='.repeat(80));
  }
  
  // Get metrics as JSON
  getMetrics() {
    return {
      ...this.systemMetrics,
      activeRequests: this.requestMetrics.size,
      timestamp: new Date().toISOString()
    };
  }
  
  // Clear metrics
  clearMetrics() {
    this.requestMetrics.clear();
    this.systemMetrics = {
      requests: { total: 0, success: 0, failed: 0 },
      performance: { avgResponseTime: 0, maxResponseTime: 0, minResponseTime: Infinity },
      errors: { total: 0, byType: {} },
      webhooks: { processed: 0, failed: 0, avgProcessingTime: 0 },
      database: { queries: 0, errors: 0, avgQueryTime: 0 },
      cache: { hits: 0, misses: 0, hitRate: 0 },
      queue: { enqueued: 0, processed: 0, failed: 0, avgProcessingTime: 0 }
    };
    this.info('Metrics cleared');
  }
}

// Create singleton instance
const logger = new Logger({
  level: process.env.LOG_LEVEL || 'info',
  name: 'omi-app',
  console: true,
  file: process.env.ENABLE_FILE_LOGGING === 'true',
  tableOutput: true
});

// Export logger instance and class
module.exports = { logger, Logger };