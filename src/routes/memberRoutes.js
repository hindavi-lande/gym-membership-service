const { Router } = require('express');
const memberController = require('../controllers/memberController');

const router = Router();

router.get('/', memberController.list);
router.post('/:id/merge', memberController.merge);
router.get('/:id', memberController.getById);
router.post('/', memberController.create);
router.put('/:id', memberController.update);
router.delete('/:id', memberController.remove);

module.exports = router;
