const express = require('express');
const router = express.Router();
const os = require("os");

router.get('/', async (req, res) => {
  res.status(200).json({
    message: "Pong!",
    time: Date.now(),
    node: os.hostname(),
  });
});

module.exports = router;