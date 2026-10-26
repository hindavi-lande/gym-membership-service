const { Router } = require('express');
const memberController = require('../controllers/memberController');

const router = Router();

router.get('/', memberController.list);
router.get('/:id', memberController.getById);
router.post('/', memberController.create);
router.post('/:id/renew', memberController.renew);
router.post('/:id/cancel', memberController.cancel);
router.get('/:id/payments', memberController.listPayments);
router.put('/:id', memberController.update);
router.delete('/:id', memberController.remove);

module.exports = router;
