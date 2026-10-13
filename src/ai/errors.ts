/** An error with a message the team can act on and the HTTP status to return. */
export class GenerationError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}
