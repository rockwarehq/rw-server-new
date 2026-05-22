import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TagSnapshotCache } from "./tag-snapshot-cache.js";

describe("TagSnapshotCache", () => {
  test("stores snapshot for new key using input previousValue", () => {
    const cache = new TagSnapshotCache();
    cache.upsertPointReading({
      pointId: "p1",
      value: 1,
      previousValue: 0,
      quality: "GOOD",
    });

    const snapshot = cache.getSnapshot("p1");
    assert.equal(snapshot?.value, 1);
    assert.equal(snapshot?.previousValue, 0);
  });

  test("uses existing value as previousValue when input lacks previousValue", () => {
    const cache = new TagSnapshotCache();
    cache.upsertPointReading({
      pointId: "p1",
      value: 5,
    });
    cache.upsertPointReading({
      pointId: "p1",
      value: 7,
    });

    const snapshot = cache.getSnapshot("p1");
    assert.equal(snapshot?.value, 7);
    assert.equal(snapshot?.previousValue, 5);
  });

  test("uses input previousValue when value differs from existing", () => {
    const cache = new TagSnapshotCache();
    cache.upsertPointReading({
      pointId: "p1",
      value: 0,
    });
    cache.upsertPointReading({
      pointId: "p1",
      value: 1,
      previousValue: 0,
    });

    const snapshot = cache.getSnapshot("p1");
    assert.equal(snapshot?.value, 1);
    assert.equal(snapshot?.previousValue, 0);
  });

  test("suppresses duplicate: sets previousValue to existing value when incoming value matches cached value", () => {
    const cache = new TagSnapshotCache();
    cache.upsertPointReading({
      pointId: "p1",
      value: 1,
      previousValue: 0,
    });

    assert.equal(cache.getSnapshot("p1")?.previousValue, 0);

    cache.upsertPointReading({
      pointId: "p1",
      value: 1,
      previousValue: 0,
    });

    const snapshot = cache.getSnapshot("p1");
    assert.equal(snapshot?.value, 1);
    assert.equal(snapshot?.previousValue, 1);
  });

  test("does not suppress when incoming value differs from cached value", () => {
    const cache = new TagSnapshotCache();
    cache.upsertPointReading({
      pointId: "p1",
      value: 1,
      previousValue: 0,
    });
    cache.upsertPointReading({
      pointId: "p1",
      value: 2,
      previousValue: 1,
    });

    const snapshot = cache.getSnapshot("p1");
    assert.equal(snapshot?.value, 2);
    assert.equal(snapshot?.previousValue, 1);
  });

  test("handles null existing value correctly with duplicate", () => {
    const cache = new TagSnapshotCache();
    cache.setSnapshot({
      key: "p1",
      pointId: "p1",
      value: null,
      previousValue: "old",
      source: "stream",
    });
    cache.setSnapshot({
      key: "p1",
      pointId: "p1",
      value: null,
      previousValue: "something",
      source: "stream",
    });

    const snapshot = cache.getSnapshot("p1");
    assert.equal(snapshot?.value, null);
    assert.equal(snapshot?.previousValue, null);
  });
});
