const express = require('express');
const router = express.Router();

const firestore = require('../firestore');

router.get('/', async (req, res) => {
  const db = firestore();

  const colPatrons = await db.collection('patrons').where('status', '==', 'active_patron').get();
  let numPatrons = 0
  let sumCents = 0
  colPatrons.forEach(doc => {
    numPatrons += 1
    sumCents += doc.data().cents || 0
  });

  const colCorp = await db.collection('corporate_sponsors').where('rank', '>', 0).get();
  let sumCorp = 0
  colCorp.forEach(doc => {
    sumCorp += doc.data().usd || 0
  });

  const totalFunds = (sumCents / 100) + sumCorp

  const colGoals = await db.collection('goals').orderBy('target', 'asc').get();
  let goals = {}
  colGoals.forEach(doc => {
    goals[doc.id] = doc.data();
  });

  const funding = {
    num_patrons: numPatrons,
    patronFunds: sumCents / 100,
    corpFunds: sumCorp,
    totalFunds: totalFunds,
    goals: goals
  }

  res.status(200).json(funding)
});

module.exports = router;
