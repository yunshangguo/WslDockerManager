// Host / engine overview + WSL resource readings.
const express = require('express');
const d = require('../docker');
const { asyncHandler } = require('./util');
const { withDockerd } = require('../conn');

const router = express.Router();

router.get('/overview', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.getOverview()));
}));

// /resources 走 WSL CLI（runWsl），不经过 127.0.0.1:2375，不会触发 ECONNREFUSED，无需包装。
router.get('/resources', asyncHandler(async (req, res) => {
  res.json(await d.getWslResources());
}));

router.get('/info', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.getInfo()));
}));

router.get('/version', asyncHandler(async (req, res) => {
  res.json(await withDockerd(() => d.getVersion()));
}));

module.exports = router;
