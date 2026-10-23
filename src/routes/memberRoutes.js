const { Router } = require('express');
const memberController = require('../controllers/memberController');

const router = Router();

router.get('/', memberController.list);
router.get('/:id', memberController.getById);
router.post('/', memberController.create);
router.put('/:id', memberController.update);
router.post('/:id/renew', memberController.renew);
router.get('/:id/payments', memberController.listPayments);
router.delete('/:id', memberController.remove);

module.exports = router;
