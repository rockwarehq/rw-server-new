import { startListener, stopListener } from "./_ported/main.js";

export async function startProcessor(): Promise<void> {
  await startListener();
}

export async function stopProcessor(): Promise<void> {
  await stopListener();
}
