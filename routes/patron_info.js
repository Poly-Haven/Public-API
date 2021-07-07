const escape = require('escape-html');
const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

const db = firestore();

require('dotenv').config()

router.use(express.json())

router.post('/', async (req, res) => {
  if (req.body.key !== process.env.PATRON_INFO_KEY) {
    res.status(403).json({
      error: "403 Forbidden",
      message: "Incorrect key"
    })
    return
  }

  const uuid = req.body.uuid

  if (!uuid) {
    res.status(400).json({
      error: "400 Bad Request",
      message: "uuid is undefined"
    })
    return
  }

  const doc = await db.collection('patrons').doc(uuid).get();
  if (!doc.exists) {
    res.status(404).json({
      error: "404 Not Found",
      message: `No patron with id ${escape(uuid)}`
    })
  } else {
    res.status(200).json(doc.data());
  }
});

module.exports = router;