import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseMessage } from "./parser.js";

function parse(topic: string, payload: string) {
  return parseMessage({
    topic,
    raw: Buffer.from(payload, "utf8"),
    receivedAt: 1_700_000_000_000,
  });
}

describe("parseMessage", () => {
  test("parses gateway health topic metadata", () => {
    const result = parse(
      "/Rockware/v1/Gateway/gateway-abc/Health",
      JSON.stringify({ status: "ok" }),
    );

    assert.equal(result.isErr(), false);
    if (result.isErr()) {
      assert.fail(`expected ok result, got ${result.error.code}`);
    }

    assert.deepEqual(result.value.metadata, {
      family: "rockware",
      version: "1",
      gatewayId: "gateway-abc",
      resource: "Health",
      scope: "gateway",
    });
  });

  test("parses device health topic metadata", () => {
    const result = parse(
      "/Rockware/v42/Gateway/gw-1/Device/device-9/Health",
      JSON.stringify({ status: "ok" }),
    );

    assert.equal(result.isErr(), false);
    if (result.isErr()) {
      assert.fail(`expected ok result, got ${result.error.code}`);
    }

    assert.deepEqual(result.value.metadata, {
      family: "rockware",
      version: "42",
      gatewayId: "gw-1",
      deviceId: "device-9",
      resource: "Health",
      scope: "device",
    });
  });

  test("parses device points topic metadata", () => {
    const result = parse(
      "/Rockware/v2026.02/Gateway/gw-2/Device/device-15/Points",
      JSON.stringify({ points: [] }),
    );

    assert.equal(result.isErr(), false);
    if (result.isErr()) {
      assert.fail(`expected ok result, got ${result.error.code}`);
    }

    assert.deepEqual(result.value.metadata, {
      family: "rockware",
      version: "2026.02",
      gatewayId: "gw-2",
      deviceId: "device-15",
      resource: "Points",
      scope: "device",
    });
  });

  test("parses matching topics with trailing slash", () => {
    const result = parse(
      "/Rockware/v1/Gateway/gateway-abc/Device/device-1/Health/",
      JSON.stringify({ status: "ok" }),
    );

    assert.equal(result.isErr(), false);
    if (result.isErr()) {
      assert.fail(`expected ok result, got ${result.error.code}`);
    }

    assert.deepEqual(result.value.metadata, {
      family: "rockware",
      version: "1",
      gatewayId: "gateway-abc",
      deviceId: "device-1",
      resource: "Health",
      scope: "device",
    });
  });

  test("parses matching topics with repeated trailing slashes", () => {
    const result = parse(
      "/Rockware/v1/Gateway/gateway-abc/Device/device-1/Health///",
      JSON.stringify({ status: "ok" }),
    );

    assert.equal(result.isErr(), false);
    if (result.isErr()) {
      assert.fail(`expected ok result, got ${result.error.code}`);
    }

    assert.deepEqual(result.value.metadata, {
      family: "rockware",
      version: "1",
      gatewayId: "gateway-abc",
      deviceId: "device-1",
      resource: "Health",
      scope: "device",
    });
  });

  test("accepts non-matching topics with null metadata", () => {
    const result = parse("other/vendor/topic", JSON.stringify({ ok: true }));

    assert.equal(result.isErr(), false);
    if (result.isErr()) {
      assert.fail(`expected ok result, got ${result.error.code}`);
    }

    assert.equal(result.value.metadata, null);
  });

  test("returns invalid_json for malformed JSON", () => {
    const result = parse("/Rockware/v1/Gateway/gw-1/Health", "{");

    assert.equal(result.isErr(), true);
    if (result.isOk()) {
      assert.fail("expected parse error");
    }

    assert.equal(result.error.code, "invalid_json");
  });

  test("returns invalid_payload for non-object JSON", () => {
    const result = parse("/Rockware/v1/Gateway/gw-1/Health", "123");

    assert.equal(result.isErr(), true);
    if (result.isOk()) {
      assert.fail("expected parse error");
    }

    assert.equal(result.error.code, "invalid_payload");
  });
});
