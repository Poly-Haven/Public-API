const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const os = require("os");

const interface = os.networkInterfaces()["ens3"]
let nodeID = "UNKNOWN"
if (interface) {
  const ip = interface[1].address
  nodeID = crypto.createHmac('sha256', process.env.DL_KEY)
    .update(ip)
    .digest('hex')
    .substring(0, 4)
}

router.get('/', async (req, res) => {
  res.status(200).json({
    time: Date.now(),
    node: nodeID,
  });
});

module.exports = router;