export class QuorumError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "QuorumError";
  }
}

export class RecoveringError extends QuorumError {
  constructor() {
    super("RUNTIME_RECOVERING", "Runtime is in RECOVERING state — writes rejected");
  }
}

export class QuorumUnavailableError extends QuorumError {
  constructor(public readonly reachable: number, public readonly required: number) {
    super("QUORUM_UNAVAILABLE", `Quorum unavailable: ${reachable}/${required}`, { reachable, required });
  }
}

export class IdempotentResultError extends QuorumError {
  constructor(public readonly originalSeq: number) {
    super("IDEMPOTENT_RESULT", "Duplicate idempotency key", { originalSeq });
  }
}

export class EpochMismatchError extends QuorumError {
  constructor(public readonly expected: number, public readonly actual: number) {
    super("EPOCH_MISMATCH", `Epoch mismatch: expected ${expected}, got ${actual}`, { expected, actual });
  }
}

export class RateLimitExceededError extends QuorumError {
  constructor(public readonly namespace: string) {
    super("RATE_LIMIT_EXCEEDED", `Rate limit exceeded for namespace: ${namespace}`, { namespace });
  }
}

export class SnapshotCompatibilityError extends QuorumError {
  constructor(public readonly reason: string) {
    super("SNAPSHOT_INCOMPATIBLE", reason);
  }
}
