export { ConcurrencyError } from "./types";
export type { ExpectedVersion, NewEvent, StoredEvent } from "./types";
// The only public write path: events + audit entry in one transaction.
export { appendToStream } from "@/infra/audit/audit-log";
export { readAll, readStream, streamVersion, withConcurrencyRetry } from "./store";
