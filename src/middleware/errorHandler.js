/**
 * Global Express error handling middleware.
 * Formats errors nicely, handles Axios/Power BI API error structures,
 * and hides implementation details (like stack traces) in production.
 */
export function errorHandler(err, req, res, next) {
  // Log the complete error trace internally
  console.error('[GLOBAL ERROR]', err);

  // Extract HTTP status code
  let statusCode = 500;
  if (err.response && err.response.status) {
    statusCode = err.response.status;
  } else if (err.status) {
    statusCode = err.status;
  } else if (err.statusCode) {
    statusCode = err.statusCode;
  }

  // Extract descriptive message
  let message = 'An internal server error occurred.';
  if (err.response && err.response.data) {
    // Power BI errors often have nested error messages
    const pbiError = err.response.data.error;
    message = typeof pbiError === 'string' 
      ? pbiError 
      : (pbiError?.message || JSON.stringify(err.response.data));
  } else if (err.message) {
    message = err.message;
  }

  const errorResponse = {
    status: 'error',
    statusCode,
    message,
    details: err.response?.data || null
  };

  // Only include stack trace when not in production
  if (process.env.NODE_ENV === 'development') {
    errorResponse.stack = err.stack;
  }

  res.status(statusCode).json(errorResponse);
}
