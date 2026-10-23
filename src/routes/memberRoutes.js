const { Router } = require('express');
const memberController = require('../controllers/memberController');

const router = Router();

router.get('/', memberController.list);
router.get('/:id/payments', memberController.payments);
router.get('/:id', memberController.getById);
router.post('/', memberController.create);
router.put('/:id', memberController.update);
router.delete('/:id', memberController.remove);
router.post('/:id/renew', memberController.renew);

module.exports = router;
