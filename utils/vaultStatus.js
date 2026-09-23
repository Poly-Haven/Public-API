const cachedFirestore = require('./cachedFirestore')
const { vaultIdOf } = require('./assetFilters')

const db = cachedFirestore()

/**
 * A vault moves through three states, stored on its doc in the `vaults` collection:
 *
 *   upcoming - assets can be uploaded and compiled, but the vault has not been announced.
 *   locked   - the vault is public and its assets are behind the funding goal.
 *   unlocked - the goal was met, the assets were published, and both stay on record.
 *
 * An upcoming vault usually has no doc at all - Notion's "Vault" property is its only record until
 * admin's announceVault creates one. A doc with no status counts as upcoming too, so one made by
 * hand to prepare a vault's page stays hidden until it is announced. (Every doc written before the
 * status field existed has had one set since.)
 */
const vaultStatus = (vault) => (vault && vault.status) || 'upcoming'

/** What a hidden vault's id becomes in public responses. Reserved - never a real vault's id. */
const UPCOMING_VAULT_ID = 'upcoming'

/**
 * Ids of the vaults the public may know about: locked or unlocked. Whatever else an asset names -
 * an upcoming vault, a doc-less Notion vault, a typo - is masked. Fails closed on purpose: a vault
 * stays hidden unless its doc positively says it is public.
 */
const publicVaultIds = async () => {
  const colVaults = await db.collection('vaults').get()
  const ids = new Set()
  colVaults.forEach((doc) => {
    if (vaultStatus(doc.data()) !== 'upcoming') ids.add(doc.id)
  })
  return ids
}

/**
 * An asset as the public may see it. In a vault that hasn't been announced, the vault id becomes
 * UPCOMING_VAULT_ID and everything else carrying it - its tag, the legacy "vault: <id>" category -
 * is dropped, so the asset is attributed to "an upcoming vault" and nothing more.
 *
 * Masked rather than withheld: these are early-access assets like any other, already gated by
 * their year-3000 date. Returns a copy when it changes anything and never mutates, because callers
 * may hand in the shared cached object.
 */
const maskVault = (asset, publicIds) => {
  const id = vaultIdOf(asset)
  if (!id || id === UPCOMING_VAULT_ID || publicIds.has(id)) return asset
  // Admin tags a vault's assets with its id in tag form ("night city"), older ones with the id
  // itself ("beach").
  const tagForms = new Set([id, id.replace(/_/g, ' ')])
  const masked = { ...asset, vault: UPCOMING_VAULT_ID }
  if (Array.isArray(asset.tags)) {
    masked.tags = asset.tags.filter((tag) => !(typeof tag === 'string' && tagForms.has(tag.toLowerCase())))
  }
  if (Array.isArray(asset.categories)) {
    masked.categories = asset.categories.filter((cat) => cat !== `vault: ${id}`)
  }
  return masked
}

module.exports = { vaultStatus, UPCOMING_VAULT_ID, publicVaultIds, maskVault }
