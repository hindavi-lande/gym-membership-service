require('dotenv').config();

const app = require('./app');
const { sequelize } = require('./models');

const PORT = process.env.PORT || 3000;

async function start() {
  await sequelize.authenticate();
  await sequelize.sync();

  app.listen(PORT, () => {
    console.log(`gym-membership-service listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
