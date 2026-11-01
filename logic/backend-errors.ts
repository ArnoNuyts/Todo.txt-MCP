/**
 * A write conflict detected by the storage layer, such as a failed WebDAV
 * `If-Match` precondition. Tool handlers map this to the `CONFLICT` code so
 * clients know they must reload before retrying.
 */
export class BackendConflictError extends Error {
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BackendConflictError";
    this.details = details;
  }
}
