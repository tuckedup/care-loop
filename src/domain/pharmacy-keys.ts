// Deterministic ids for the one pharmacy transmission of a renewal (F048). Pure.
/** One transmission per renewal: the key is derived, so a replayed approval can never add a second. */
export const rxIdempotencyKey = (renewalId: string) => `rx-renewal:${renewalId}`;
export const rxMessageId = (renewalId: string) => `rxmsg-${renewalId}`;
