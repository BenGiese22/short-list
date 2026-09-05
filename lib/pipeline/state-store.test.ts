import { describe, expect, it } from 'vitest'
import { STATE_STORE_ID_VAR, requireStateStoreId } from './state-store'

describe('requireStateStoreId', () => {
  it('returns the configured store id', () => {
    expect(requireStateStoreId({ [STATE_STORE_ID_VAR]: 'store_abc' })).toBe('store_abc')
  })

  it('refuses to fall back when the id is missing', () => {
    // The failure this exists for: @vercel/blob resolves OIDC + storeId
    // BEFORE BLOB_READ_WRITE_TOKEN, but with no storeId it drops through to
    // that token -- the PUBLIC photo store. The reaper would write the
    // Compass session there, where anyone with the link can replay it.
    expect(() => requireStateStoreId({})).toThrow(STATE_STORE_ID_VAR)
    expect(() => requireStateStoreId({ [STATE_STORE_ID_VAR]: '   ' })).toThrow()
  })

  it('names the variable rather than printing a value', () => {
    expect(() => requireStateStoreId({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_secret' }))
      .toThrow(/STATE_BLOB_STORE_ID/)
    expect(() => requireStateStoreId({ BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_secret' }))
      .not.toThrow(/vercel_blob_rw_secret/)
  })
})
