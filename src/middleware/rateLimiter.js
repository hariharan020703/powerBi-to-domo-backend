import rateLimit from 'express-rate-limit';

/**
 * Standard API rate limiter.
 * Limits each IP to 100 requests per 15-minute window.
 */
export const rateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 100 requests per window
  standardHeaders: true, // Return rate limit info in standard headers
  legacyHeaders: false, // Disable legacy headers
  message: {
    status: 429,
    error: 'Too Many Requests',
    message: 'Too many requests from this IP. Please try again after 15 minutes.'
  }
});
