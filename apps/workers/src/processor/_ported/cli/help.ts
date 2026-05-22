export function printHelp(): void {
  console.log("Usage:");
  console.log("  pnpm dev                          Start listener mode");
  console.log("  pnpm dev send [topic] [message]");
  console.log("                                    Publish a single MQTT message");
  console.log("  pnpm dev help                     Show help");
}
