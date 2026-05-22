import mqtt from "mqtt";

import { loadConfig } from "../config.js";

function connectClient() {
  const config = loadConfig();
  return mqtt.connect(config.mqtt.brokerUrl, {
    username: config.mqtt.username,
    password: config.mqtt.password,
  });
}

export async function runSendCommand(args: string[]): Promise<number> {
  const topic = args[0] || "test/sample";
  const message = args[1] || JSON.stringify({ event: "sample", timestamp: Date.now() });

  const client = connectClient();

  return new Promise<number>((resolve) => {
    client.on("connect", () => {
      console.log(`Publishing to ${topic}...`);
      client.publish(topic, message, (error?: Error) => {
        if (error) {
          console.error("Failed to publish:", error.message);
          client.end(true, () => resolve(1));
          return;
        }

        console.log(`Published: ${message}`);
        client.end(true, () => resolve(0));
      });
    });

    client.on("error", (error: Error) => {
      console.error("MQTT send error:", error.message);
      client.end(true, () => resolve(1));
    });
  });
}
