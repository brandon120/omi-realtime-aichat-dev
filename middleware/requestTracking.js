'use strict';

const crypto = require('crypto');
const { logger } = require('../services/logger');

/**
 * Request tracking middleware
 * Tracks all incoming requests with unique IDs and logs performance metrics
 */
function requestTracking() {
  return (req, res, next) => {
    // Generate unique request ID
    const requestId = crypto.randomBytes(8).toString('hex');
    req.id = requestId;
    
    // Attach request ID to response for correlation
    res.setHeader('X-Request-Id', requestId);
    
    // Start request tracking
    logger.startRequest(requestId, req);
    
    // Track response
    const originalSend = res.send;
    const originalJson = res.json;
    const originalEnd = res.end;
    
    // Helper to log response
    const logResponse = (error = null) => {
      if (!res.finished) {
        logger.endRequest(requestId, res, error);
      }
    };
    
    // Override response methods to capture when response is sent
    res.send = function(data) {
      logResponse();
      return originalSend.call(this, data);
    };
    
    res.json = function(data) {
      logResponse();
      return originalJson.call(this, data);
    };
    
    res.end = function(chunk, encoding) {
      logResponse();
      return originalEnd.call(this, chunk, encoding);
    };
    
    // Handle errors
    res.on('error', (error) => {
      logger.endRequest(requestId, res, error);
    });
    
    // Handle request abortion
    req.on('close', () => {
      if (!res.finished) {
        logger.endRequest(requestId, res, new Error('Request aborted'));
      }
    });
    
    next();
  };
}

/**
 * Error handling middleware
 * Catches and logs all errors with proper formatting
 */
function errorHandler() {
  return (err, req, res, next) => {
    const requestId = req.id || 'unknown';
    
    // Log error with full details
    logger.error('Request error', {
      requestId,
      error: err.message,
      stack: err.stack,
      type: err.constructor.name,
      method: req.method,
      path: req.path,
      query: req.query,
      body: req.body
    });
    
    // Send error response
    const statusCode = err.statusCode || err.status || 500;
    const message = err.expose ? err.message : 'Internal server error';
    
    res.status(statusCode).json({
      error: message,
      requestId,
      timestamp: new Date().toISOString()
    });
  };
}

/**
 * Performance monitoring middleware
 * Tracks slow requests and logs warnings
 */
function performanceMonitoring(options = {}) {
  const slowRequestThreshold = options.slowRequestThreshold || 1000; // 1 second
  
  return (req, res, next) => {
    const startTime = Date.now();
    
    // Monitor response time
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      
      if (duration > slowRequestThreshold) {
        logger.warn('Slow request detected', {
          requestId: req.id,
          method: req.method,
          path: req.path,
          duration: `${duration}ms`,
          threshold: `${slowRequestThreshold}ms`
        });
      }
    });
    
    next();
  };
}

/**
 * Request logging middleware
 * Logs detailed request information for debugging
 */
function requestLogging(options = {}) {
  const logBody = options.logBody !== false;
  const logHeaders = options.logHeaders !== false;
  
  return (req, res, next) => {
    const logData = {
      requestId: req.id,
      method: req.method,
      url: req.url,
      path: req.path,
      query: req.query
    };
    
    if (logHeaders) {
      logData.headers = req.headers;
    }
    
    if (logBody && req.body) {
      // Sanitize sensitive data
      const sanitizedBody = { ...req.body };
      if (sanitizedBody.password) sanitizedBody.password = '[REDACTED]';
      if (sanitizedBody.token) sanitizedBody.token = '[REDACTED]';
      if (sanitizedBody.apiKey) sanitizedBody.apiKey = '[REDACTED]';
      
      logData.body = sanitizedBody;
    }
    
    logger.debug('Incoming request', logData);
    
    next();
  };
}

/**
 * Health check middleware
 * Provides system health and metrics endpoint
 */
function healthCheck(path = '/health') {
  return (req, res, next) => {
    if (req.path === path) {
      const metrics = logger.getMetrics();
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        metrics
      };
      
      return res.status(200).json(health);
    }
    next();
  };
}

/**
 * Metrics dashboard middleware
 * Provides HTML dashboard for real-time metrics
 */
function metricsDashboard(path = '/metrics-dashboard') {
  return (req, res, next) => {
    if (req.path === path) {
      const metrics = logger.getMetrics();
      
      const html = `
<!DOCTYPE html>
<html>
<head>
  <title>OMI Metrics Dashboard</title>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      margin: 0;
      padding: 20px;
      color: #333;
    }
    .container {
      max-width: 1200px;
      margin: 0 auto;
      background: white;
      border-radius: 10px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
      padding: 30px;
    }
    h1 {
      color: #667eea;
      text-align: center;
      margin-bottom: 30px;
    }
    .metrics-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
      gap: 20px;
      margin-bottom: 30px;
    }
    .metric-card {
      background: #f7f9fc;
      border-radius: 8px;
      padding: 20px;
      border-left: 4px solid #667eea;
    }
    .metric-card h3 {
      margin: 0 0 15px 0;
      color: #667eea;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 1px;
    }
    .metric-value {
      font-size: 32px;
      font-weight: bold;
      color: #333;
      margin-bottom: 5px;
    }
    .metric-label {
      color: #666;
      font-size: 14px;
    }
    .table-container {
      overflow-x: auto;
      margin-bottom: 20px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th, td {
      padding: 12px;
      text-align: left;
      border-bottom: 1px solid #e0e0e0;
    }
    th {
      background: #f7f9fc;
      font-weight: 600;
      color: #667eea;
    }
    .status-badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-success { background: #d4edda; color: #155724; }
    .status-error { background: #f8d7da; color: #721c24; }
    .status-warning { background: #fff3cd; color: #856404; }
    .refresh-note {
      text-align: center;
      color: #666;
      margin-top: 20px;
      font-size: 14px;
    }
    .progress-bar {
      width: 100%;
      height: 20px;
      background: #e0e0e0;
      border-radius: 10px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      background: linear-gradient(90deg, #667eea, #764ba2);
      transition: width 0.3s ease;
    }
  </style>
  <script>
    setTimeout(() => location.reload(), 10000);
  </script>
</head>
<body>
  <div class="container">
    <h1>🚀 OMI Real-Time Metrics Dashboard</h1>
    
    <div class="metrics-grid">
      <div class="metric-card">
        <h3>Total Requests</h3>
        <div class="metric-value">${metrics.requests.total}</div>
        <div class="metric-label">
          <span class="status-badge status-success">${metrics.requests.success} Success</span>
          <span class="status-badge status-error">${metrics.requests.failed} Failed</span>
        </div>
      </div>
      
      <div class="metric-card">
        <h3>Performance</h3>
        <div class="metric-value">${metrics.performance.avgResponseTime.toFixed(2)}ms</div>
        <div class="metric-label">Average Response Time</div>
      </div>
      
      <div class="metric-card">
        <h3>Webhooks</h3>
        <div class="metric-value">${metrics.webhooks.processed}</div>
        <div class="metric-label">
          Processed (${metrics.webhooks.failed} failed)
        </div>
      </div>
      
      <div class="metric-card">
        <h3>Database</h3>
        <div class="metric-value">${metrics.database.queries}</div>
        <div class="metric-label">
          Total Queries (${metrics.database.avgQueryTime.toFixed(2)}ms avg)
        </div>
      </div>
      
      <div class="metric-card">
        <h3>Cache Performance</h3>
        <div class="metric-value">${metrics.cache.hitRate || '0%'}</div>
        <div class="metric-label">Hit Rate</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${metrics.cache.hitRate || '0%'}"></div>
        </div>
      </div>
      
      <div class="metric-card">
        <h3>Queue Status</h3>
        <div class="metric-value">${metrics.queue.processed}</div>
        <div class="metric-label">
          Jobs Processed (${metrics.queue.enqueued} enqueued)
        </div>
      </div>
    </div>
    
    ${metrics.errors.total > 0 ? `
    <div class="table-container">
      <h2>❌ Error Breakdown</h2>
      <table>
        <thead>
          <tr>
            <th>Error Type</th>
            <th>Count</th>
            <th>Percentage</th>
          </tr>
        </thead>
        <tbody>
          ${Object.entries(metrics.errors.byType).map(([type, count]) => `
            <tr>
              <td>${type}</td>
              <td>${count}</td>
              <td>${(count / metrics.errors.total * 100).toFixed(2)}%</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    ` : ''}
    
    <div class="table-container">
      <h2>📊 System Information</h2>
      <table>
        <thead>
          <tr>
            <th>Metric</th>
            <th>Value</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Uptime</td>
            <td>${(process.uptime() / 3600).toFixed(2)} hours</td>
          </tr>
          <tr>
            <td>Memory Usage</td>
            <td>${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(2)} MB</td>
          </tr>
          <tr>
            <td>Active Requests</td>
            <td>${metrics.activeRequests}</td>
          </tr>
          <tr>
            <td>Success Rate</td>
            <td>
              <span class="status-badge ${metrics.requests.total > 0 && (metrics.requests.success / metrics.requests.total) > 0.95 ? 'status-success' : 'status-warning'}">
                ${metrics.requests.total > 0 ? (metrics.requests.success / metrics.requests.total * 100).toFixed(2) : 0}%
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    
    <div class="refresh-note">
      ⏱️ Auto-refreshing every 10 seconds | Last updated: ${new Date().toLocaleTimeString()}
    </div>
  </div>
</body>
</html>
      `;
      
      res.setHeader('Content-Type', 'text/html');
      return res.send(html);
    }
    next();
  };
}

module.exports = {
  requestTracking,
  errorHandler,
  performanceMonitoring,
  requestLogging,
  healthCheck,
  metricsDashboard
};