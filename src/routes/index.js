const { Router } = require('express');
const memberRoutes = require('./memberRoutes');

const router = Router();

router.get('/health', (req, res) => res.json({ status: 'ok' }));
router.use('/members', memberRoutes);

module.exports = router;
