import { Result } from "better-result";

import { ParseError, type JsonObject, type ParseResult, type TopicMetadata } from "./types.js";

let eventCounter = 0;

function nextEventId(topic: string, receivedAt: number): string {
  eventCounter = (eventCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${topic}:${receivedAt}:${eventCounter}`;
}

function parseTopicMetadata(topic: string): TopicMetadata | null {
  const normalizedTopic = topic.replace(/\/+$/, "");
  const topicWithoutLeadingSlash = normalizedTopic.startsWith("/")
    ? normalizedTopic.slice(1)
    : normalizedTopic;
  const segments = topicWithoutLeadingSlash.split("/");
  if (segments.length < 5) {
    return null;
  }

  if (segments[0] !== "Rockware" || segments[2] !== "Gateway") {
    return null;
  }

  const versionToken = segments[1];
  if (!versionToken) {
    return null;
  }

  const versionMatch = /^v(.+)$/.exec(versionToken);
  if (!versionMatch || !versionMatch[1]) {
    return null;
  }

  const gatewayId = segments[3];
  if (!gatewayId) {
    return null;
  }

  if (segments.length === 5 && segments[4] === "Health") {
    return {
      family: "rockware",
      version: versionMatch[1],
      gatewayId,
      resource: "Health",
      scope: "gateway",
    };
  }

  const resource = segments[6];
  if (
    segments.length === 7 &&
    segments[4] === "Device" &&
    (resource === "Health" || resource === "Points")
  ) {
    const deviceId = segments[5];
    if (!deviceId) {
      return null;
    }

    return {
      family: "rockware",
      version: versionMatch[1],
      gatewayId,
      deviceId,
      resource,
      scope: "device",
    };
  }

  return null;
}

export function parseMessage(input: {
  topic: string;
  raw: Buffer;
  receivedAt: number;
}): ParseResult {
  const rawString = input.raw.toString("utf8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawString);
  } catch {
    return Result.err(
      new ParseError({
        code: "invalid_json",
        message: "Payload is not valid JSON",
        topic: input.topic,
      }),
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return Result.err(
      new ParseError({
        code: "invalid_payload",
        message: "Payload must be a JSON object",
        topic: input.topic,
      }),
    );
  }

  return Result.ok({
    id: nextEventId(input.topic, input.receivedAt),
    topic: input.topic,
    metadata: parseTopicMetadata(input.topic),
    receivedAt: input.receivedAt,
    parsedAt: Date.now(),
    payload: parsed as JsonObject,
    raw: input.raw,
  });
}
