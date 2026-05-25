# ADR 0002: CP Over AP for Write Path

**Status:** Accepted  
**Date:** 2026-05-25

## Context

CAP theorem forces a choice between consistency and availability during network partitions on the write path.

## Decision

QUORUM is CP on the write path. Writes block if quorum is unreachable.

## Rationale

A lock service that silently accepts writes during a partition provides no coordination guarantee. The value of a distributed lock is its safety property.

## Consequences

- Writes block during partition (unavailable but consistent)
- Eventual reads available for use cases tolerating stale state
- Operators must monitor quorum health

## Alternatives Rejected

- AP writes: would allow two lock holders simultaneously
