const express = require('express');
const router = express.Router();

router.get('/', async (req, res) => {
  res.status(501).send("Coming soon");
});

module.exports = router;