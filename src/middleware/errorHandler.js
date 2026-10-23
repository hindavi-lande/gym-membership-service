const ApiError = require('../utils/ApiError');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({ message: err.message });
  }

  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({ message: err.errors.map((e) => e.message).join(', ') });
  }

  console.error(err);
  return res.status(500).json({ message: 'Internal server error' });
}

module.exports = errorHandler;
