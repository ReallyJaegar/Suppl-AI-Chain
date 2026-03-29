// src/utils/asyncHandler.js
// Wraps async route handlers so errors are forwarded to Express error middleware.
// Instead of wrapping every route in try/catch, just wrap with asyncHandler().

export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
