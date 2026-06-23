/**
 * Pagination Middleware - ISSUE-013 Fix
 */

function paginationMiddleware(req, res, next) {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100
  const offset = (page - 1) * limit;
  
  req.pagination = { page, limit, offset };
  next();
}

function paginatedResponse(data, total, req) {
  const { page, limit } = req.pagination;
  const totalPages = Math.ceil(total / limit);
  
  return {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1
    }
  };
}

module.exports = { paginationMiddleware, paginatedResponse };
