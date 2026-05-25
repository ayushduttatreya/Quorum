# ADR 0001: SQLite for Hot Coordination Log

**Status:** Accepted  
**Date:** 2026-05-25  
**Deciders:** Architecture team

## Context

The RCL requires ordered sequential storage with range query, compaction, and transactional append semantics.

## Decision

Use Durable Object SQLite (`this.storage.sql`) for the hot log.

## Rationale

KV storage requires reimplementing sequence indexing, range scans, and compaction. SQLite provides these natively.

## Consequences

- Fast range queries for replay (`WHERE seq >= ? ORDER BY seq LIMIT ?`)
- Transactional compaction (`DELETE WHERE seq <= ?`)
- 128 byte key limit of KV is not a constraint

## Alternatives Rejected

- DO KV: no native range scans
- R2 for hot log: too high latency for commit path
