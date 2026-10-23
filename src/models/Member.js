const { DataTypes } = require('sequelize');
const sequelize = require('../config/database');

const Member = sequelize.define('Member', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  firstName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  lastName: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: false,
    unique: true,
    validate: { isEmail: true },
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  membershipPlan: {
    type: DataTypes.ENUM('BASIC', 'STANDARD', 'PREMIUM'),
    allowNull: false,
    defaultValue: 'BASIC',
  },
  status: {
    type: DataTypes.ENUM('ACTIVE', 'INACTIVE', 'SUSPENDED'),
    allowNull: false,
    defaultValue: 'ACTIVE',
  },
  joinedAt: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
  renewalDate: {
    type: DataTypes.DATEONLY,
    allowNull: false,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'members',
  timestamps: true,
});

module.exports = Member;
