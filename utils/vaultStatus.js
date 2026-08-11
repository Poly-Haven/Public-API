const cachedFirestore = require('./cachedFirestore')

const db = cachedFirestore()

/**
 * A vault moves through three states, stored on its doc in the `vaults` collection:
 *
 *   upcoming - assets can be uploaded and compiled, but the vault has not been announced.
 *   locked   - the vault is public and its assets are behind the funding goal.
 *   unlocked - the goal was met, the assets were published, and both stay on record.
 *
 * Docs written before the status field have none. Vaults only ever existed while locked back then
 * (releasing one deleted the doc), so an absent status means locked.
 */
const vaultStatus = (vault) => (vault && vault.status) || 'locked'

/**
 * Ids of vaults not yet announced. Assets belonging to one are withheld from the listing
 * endpoints so they stay out of the library, while /info still serves them - their asset pages
 * are unlinked, and the assets go public shortly anyway.
 */
const upcomingVaultIds = async () => {
  const colVaults = await db.collection('vaults').get()
  const ids = new Set()
  colVaults.forEach((doc) => {
    if (vaultStatus(doc.data()) === 'upcoming') ids.add(doc.id)
  })
  return ids
}

module.exports = { vaultStatus, upcomingVaultIds }
