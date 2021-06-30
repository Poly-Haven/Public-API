const escape = require('escape-html');
const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /author/[id]`);
});

router.get('/:id', async (req, res) => {
  const asset_id = req.params.id;

  const doc = await db.collection('authors').doc(asset_id).get();
  if (!doc.exists) {
    res.status(404).send(`No author with id ${escape(asset_id)}`);
  } else {
    res.status(200).json(doc.data());
  }
});

module.exports = router;