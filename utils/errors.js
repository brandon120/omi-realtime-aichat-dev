'use strict';

/**
 * Custom error classes for better error handling and debugging
 */

// Base error class
class AppError extends Error {
  constructor(message, statusCode = 500, details = {}) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.details = details;
    this.timestamp = new Date().toISOString();
    this.expose = statusCode < 500; // Expose client errors, hide server errors
    
    // Capture stack trace
    Error.captureStackTrace(this, this.constructor);
  }
  
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      statusCode: this.statusCode,
      details: this.details,
      timestamp: this.timestamp,
      stack: this.stack
    };
  }
}

// Validation error
class ValidationError extends AppError {
  constructor(message, fields = {}) {
    super(message, 400, { fields });
    this.name = 'ValidationError';
  }
}

// Authentication error
class AuthenticationError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401);
    this.name = 'AuthenticationError';
  }
}

// Authorization error
class AuthorizationError extends AppError {
  constructor(message = 'Insufficient permissions') {
    super(message, 403);
    this.name = 'AuthorizationError';
  }
}

// Not found error
class NotFoundError extends AppError {
  constructor(resource = 'Resource', identifier = '') {
    const message = identifier 
      ? `${resource} with identifier '${identifier}' not found`
      : `${resource} not found`;
    super(message, 404);
    this.name = 'NotFoundError';
  }
}

// Conflict error
class ConflictError extends AppError {
  constructor(message, conflictingResource = '') {
    super(message, 409, { conflictingResource });
    this.name = 'ConflictError';
  }
}

// Rate limit error
class RateLimitError extends AppError {
  constructor(retryAfter = 60) {
    super('Too many requests', 429, { retryAfter });
    this.name = 'RateLimitError';
    this.retryAfter = retryAfter;
  }
}

// External service error
class ExternalServiceError extends AppError {
  constructor(service, originalError = null) {
    const message = `External service error: ${service}`;
    super(message, 502, { 
      service, 
      originalError: originalError?.message || originalError 
    });
    this.name = 'ExternalServiceError';
  }
}

// Database error
class DatabaseError extends AppError {
  constructor(operation, originalError = null) {
    const message = `Database operation failed: ${operation}`;
    super(message, 500, { 
      operation, 
      originalError: originalError?.message || originalError 
    });
    this.name = 'DatabaseError';
  }
}

// Configuration error
class ConfigurationError extends AppError {
  constructor(message, missingConfig = []) {
    super(message, 500, { missingConfig });
    this.name = 'ConfigurationError';
    this.expose = false; // Never expose configuration errors
  }
}

// Webhook error
class WebhookError extends AppError {
  constructor(message, sessionId = '', details = {}) {
    super(message, 500, { sessionId, ...details });
    this.name = 'WebhookError';
  }
}

// OpenAI error wrapper
class OpenAIError extends AppError {
  constructor(originalError, operation = 'unknown') {
    const message = `OpenAI API error during ${operation}`;
    super(message, 502, { 
      operation,
      originalError: originalError?.message || originalError,
      code: originalError?.code,
      type: originalError?.type
    });
    this.name = 'OpenAIError';
  }
}

// Queue error
class QueueError extends AppError {
  constructor(jobType, jobId, originalError = null) {
    const message = `Queue job failed: ${jobType}`;
    super(message, 500, { 
      jobType, 
      jobId,
      originalError: originalError?.message || originalError 
    });
    this.name = 'QueueError';
  }
}

// Error factory for creating appropriate errors from unknown errors
class ErrorFactory {
  static create(error, context = {}) {
    // If already an AppError, return as is
    if (error instanceof AppError) {
      return error;
    }
    
    // Handle Prisma errors
    if (error.code?.startsWith('P')) {
      return this.handlePrismaError(error, context);
    }
    
    // Handle OpenAI errors
    if (error.response?.headers?.['openai-organization']) {
      return new OpenAIError(error, context.operation);
    }
    
    // Handle common HTTP status codes
    if (error.statusCode || error.status) {
      const statusCode = error.statusCode || error.status;
      const message = error.message || 'An error occurred';
      
      switch (statusCode) {
        case 400:
          return new ValidationError(message);
        case 401:
          return new AuthenticationError(message);
        case 403:
          return new AuthorizationError(message);
        case 404:
          return new NotFoundError();
        case 409:
          return new ConflictError(message);
        case 429:
          return new RateLimitError();
        default:
          return new AppError(message, statusCode);
      }
    }
    
    // Default to generic app error
    return new AppError(
      error.message || 'An unexpected error occurred',
      500,
      { originalError: error.toString(), context }
    );
  }
  
  static handlePrismaError(error, context = {}) {
    const { code, meta, clientVersion } = error;
    
    switch (code) {
      case 'P2002':
        return new ConflictError(
          'A record with this value already exists',
          meta?.target
        );
      case 'P2025':
        return new NotFoundError(
          context.resource || 'Record',
          context.identifier
        );
      case 'P2003':
        return new ValidationError(
          'Foreign key constraint failed',
          { field: meta?.field_name }
        );
      case 'P2000':
        return new ValidationError(
          'Value too long for column',
          { column: meta?.column }
        );
      default:
        return new DatabaseError(
          context.operation || 'query',
          error
        );
    }
  }
}

// Error handler middleware
function createErrorHandler(logger) {
  return (err, req, res, next) => {
    // Convert to AppError if needed
    const error = ErrorFactory.create(err, {
      method: req.method,
      path: req.path,
      requestId: req.id
    });
    
    // Log the error
    if (error.statusCode >= 500) {
      logger.error(error.message, {
        requestId: req.id,
        error: error.toJSON(),
        method: req.method,
        path: req.path,
        query: req.query,
        body: req.body
      });
    } else {
      logger.warn(error.message, {
        requestId: req.id,
        statusCode: error.statusCode,
        details: error.details
      });
    }
    
    // Send response
    const response = {
      error: error.expose ? error.message : 'Internal server error',
      requestId: req.id,
      timestamp: error.timestamp
    };
    
    // Include details in development
    if (process.env.NODE_ENV === 'development') {
      response.details = error.details;
      response.stack = error.stack;
    }
    
    // Add retry-after header for rate limit errors
    if (error instanceof RateLimitError) {
      res.setHeader('Retry-After', error.retryAfter);
    }
    
    res.status(error.statusCode).json(response);
  };
}

// Async error wrapper for route handlers
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = {
  AppError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  ExternalServiceError,
  DatabaseError,
  ConfigurationError,
  WebhookError,
  OpenAIError,
  QueueError,
  ErrorFactory,
  createErrorHandler,
  asyncHandler
};