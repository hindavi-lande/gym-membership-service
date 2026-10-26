const memberService = require('../services/memberService');

async function list(req, res, next) {
  try {
    const members = await memberService.listMembers();
    res.json(members);
  } catch (err) {
    next(err);
  }
}

async function getById(req, res, next) {
  try {
    const member = await memberService.getMemberProfileById(req.params.id);
    res.json(member);
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const member = await memberService.createMember(req.body);
    res.status(201).json(member);
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const member = await memberService.updateMember(req.params.id, req.body);
    res.json(member);
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    await memberService.deleteMember(req.params.id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  getById,
  create,
  update,
  remove,
};
