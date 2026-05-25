import { describe, it } from "vitest";

describe("RclEngine", () => {
  it.todo("initializes schema on first use");
  it.todo("appends an entry and returns seq=1");
  it.todo("rejects duplicate idempotency key");
  it.todo("marks entry committed by seq");
  it.todo("getUncommitted returns only uncommitted entries");
});
