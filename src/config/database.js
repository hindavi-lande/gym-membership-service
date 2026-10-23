const { Sequelize } = require('sequelize');

const sequelize = new Sequelize({
  dialect: 'sqlite',
  storage: process.env.DB_STORAGE || './data/dev.sqlite',
  logging: false,
});

module.exports = sequelize;
