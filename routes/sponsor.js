const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

router.get('/', (req, res) => {
  res.status(400).send(`Please format your request as /sponsor/[id]`);
});

router.get('/:id', async (req, res) => {
  const uid = req.params.id;

  const doc = await db.collection('patrons').doc(uid).get();
  if (!doc.exists) {
    res.status(404).send(`No sponsor with id ${uid}`);
  } else {
    const data = doc.data()
    let sponsor = {}
    sponsor.name = data.display_name || data.name
    if (data.url) {
      sponsor.url = data.url
    }
    res.status(200).json(sponsor);
  }
});

module.exports = router;