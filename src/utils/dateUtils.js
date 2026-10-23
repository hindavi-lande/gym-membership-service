function oneYearFrom(date = new Date()) {
  const next = new Date(date.getTime());
  next.setFullYear(next.getFullYear() + 1);
  return next.toISOString().slice(0, 10);
}

module.exports = {
  oneYearFrom,
};
