// Background task API: list / inspect / clear running+finished tasks.
const express = require('express');
const tasks = require('../tasks');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ tasks: tasks.listTasks() });
});

router.get('/:id', (req, res) => {
  const t = tasks.getTask(req.params.id);
  if (!t) return res.status(404).json({ error: 'task not found' });
  res.json(t);
});

// clear all finished tasks
router.delete('/', (req, res) => {
  tasks.clearFinished();
  res.json({ ok: true });
});

// remove a single task
router.delete('/:id', (req, res) => {
  tasks.removeTask(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
