const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

router.get('/', async (req, res) => {
  const db = firestore();
  const collection = await db.collection('patrons').orderBy('joined', 'desc').limit(30).get();

  let patrons = [];
  collection.forEach(doc => {
    const data = doc.data()
    if (data.status === 'active_patron') {
      patrons.push([data.uid, data.display_name || data.name, Date.parse(data.joined)])
    }
  });

  res.status(200).json(patrons)
});

module.exports = router;
