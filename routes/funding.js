const express = require('express');
const router = express.Router();

const patreon_tiers = require('../constants/patreon_tiers.json')

const firestore = require('../firestore');

router.get('/', async (req, res) => {
  const db = firestore();

  let corporateTierIDs = [];
  for (const [id, data] of Object.entries(patreon_tiers)) {
    if (data.rewards.includes("Corporate Silver")) {
      corporateTierIDs.push(id)
    }
  }

  const colPatrons = await db.collection('patrons').where('status', '==', 'active_patron').get();
  let numPatrons = 0
  let sumCents = 0
  colPatrons.forEach(doc => {
    const data = doc.data()
    let ignore = false;
    if (data.tiers && data.tiers.some(ai => corporateTierIDs.includes(ai))) {
      ignore = true
    }
    if (!ignore) {
      numPatrons += 1
      sumCents += data.cents || 0
    }
  });

  const colCorp = await db.collection('corporate_sponsors').where('rank', '>', 0).get();
  let numCorps = 0
  let sumCorp = 0
  colCorp.forEach(doc => {
    numCorps += 1
    sumCorp += doc.data().usd || 0
  });

  const totalFunds = (sumCents / 100) + sumCorp

  const colGoals = await db.collection('goals').where('target', '>', totalFunds).orderBy('target', 'asc').limit(1).get();
  let goals = []
  colGoals.forEach(doc => {
    goals.push(doc.data());
  });
  const currentGoal = goals[0] || null

  const funding = {
    numPatrons: numPatrons,
    patronFunds: Math.floor(sumCents / 100),
    numCorps: numCorps,
    corpFunds: Math.floor(sumCorp),
    totalFunds: Math.floor(totalFunds),
    goal: currentGoal
  }

  res.status(200).json(funding)
});

module.exports = router;
