const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  res.status(200).json({
    time: Date.now(),
    node: process.env.NODE_ID || "UNKNOWN",
  });
});

module.exports = router;