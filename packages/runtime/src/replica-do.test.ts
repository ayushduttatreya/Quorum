import { describe, it } from "vitest";

describe("ReplicaDO", () => {
  it.todo("accepts first entry when prevSeq=0");
  it.todo("returns GAP_DETECTED when prevSeq does not match tail");
  it.todo("returns STALE_EPOCH when leaderEpoch is less than replica epoch");
  it.todo("returns CHECKSUM_MISMATCH on bad prevChecksum");
});
