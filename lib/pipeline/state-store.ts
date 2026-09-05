/**
 * Resolving the PRIVATE state store, and refusing to guess.
 *
 * @vercel/blob picks its credentials in this order (verified by reading
 * dist/chunk-YYMLUMXS.js, not from memory):
 *
 *   1. options.token          -> that token's store
 *   2. VERCEL_OIDC_TOKEN + a storeId  -> that store, via OIDC
 *   3. BLOB_READ_WRITE_TOKEN  -> **that** token's store
 *
 * Step 2 is what these routes want: inside a Vercel function the OIDC token
 * is injected, so passing the state store's id reaches the private store
 * without any token for it existing anywhere.
 *
 * Step 3 is the trap. If the store id is missing, the SDK does not fail --
 * it falls through to BLOB_READ_WRITE_TOKEN, which in this project points at
 * the PUBLIC store serving listing photos. The reaper would then write the
 * Compass session there, and a session behind a public URL is a credential
 * anyone holding the link can replay. `access: 'private'` cannot save it,
 * because private access is a store-level setting.
 *
 * So the id is required rather than optional, and its absence is an error
 * naming the variable.
 */

export const STATE_STORE_ID_VAR = 'STATE_BLOB_STORE_ID'

export function requireStateStoreId(
  env: Record<string, string | undefined>,
): string {
  const id = env[STATE_STORE_ID_VAR]?.trim()
  if (!id) {
    throw new Error(
      `${STATE_STORE_ID_VAR} is not set. Connect the private state Blob store ` +
        `to this project with the STATE_ prefix; without it the Blob SDK falls ` +
        `back to BLOB_READ_WRITE_TOKEN, which is the public photo store.`,
    )
  }
  return id
}
