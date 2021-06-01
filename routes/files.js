const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /files/[asset_id]`);
});

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id;

  const doc = await db.collection('files').doc(asset_id).get();
  if (!doc.exists) {
    res.status(404).send(`No asset with id ${asset_id}`);
  } else {
    res.status(200).json(doc.data());
  }
});

module.exports = router;