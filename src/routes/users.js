// User-management routes (admin only). List / create / update / delete / reset.
const express = require('express');
const auth = require('../auth');
const { asyncHandler } = require('./util');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json({ users: auth.listUsers() });
}));

router.post('/', asyncHandler(async (req, res) => {
  const { username, password, role } = req.body || {};
  const r = auth.createUser({ username, password, role });
  res.json({ ok: true, user: r });
}));

router.put('/:username', asyncHandler(async (req, res) => {
  const { role, password } = req.body || {};
  const r = auth.updateUser(req.params.username, { role, password });
  res.json({ ok: true, user: r });
}));

router.post('/:username/reset-password', asyncHandler(async (req, res) => {
  const { password } = req.body || {};
  const r = auth.updateUser(req.params.username, { password });
  res.json({ ok: true, user: r });
}));

router.delete('/:username', asyncHandler(async (req, res) => {
  const name = req.params.username;
  if (req.session.username === name) return res.status(400).json({ error: '不能删除当前登录的账户' });
  const r = auth.deleteUser(name);
  res.json({ ok: true, result: r });
}));

module.exports = router;
