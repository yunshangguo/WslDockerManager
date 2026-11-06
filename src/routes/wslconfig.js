// Read / write the Windows .wslconfig (WSL2 global limits: memory / processors / swap).
// This is the real pain point for WSL2 users on Windows — without it, WSL2 can
// greedily consume all RAM. We only touch the [wsl2] section's known keys and
// preserve the rest of the file (comments, other sections).
const express = require('express');
const d = require('../docker');
const { asyncHandler, audit } = require('./util');

const router = express.Router();

router.get('/', asyncHandler(async (req, res) => {
  res.json(d.readWslConfig());
}));

router.put('/', asyncHandler(async (req, res) => {
  const user = req.session && req.session.username;
  const patch = req.body || {};
  const r = d.writeWslConfig(patch);
  audit(user, 'wslconfig.write', JSON.stringify(patch));
  res.json(r);
}));

module.exports = router;
