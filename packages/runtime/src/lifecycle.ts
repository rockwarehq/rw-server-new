// SIGTERM/SIGINT handling + drain-timeout helper.

export type ShutdownHandler = () => Promise<void> | void;

const handlers: ShutdownHandler[] = [];
let armed = false;

export function onShutdown(handler: ShutdownHandler): void {
  handlers.push(handler);
  if (armed) return;
  armed = true;

  const drainTimeoutMs = Number.parseInt(process.env.DRAIN_TIMEOUT_MS ?? "", 10) || 25_000;

  const fire = async (signal: string) => {
    console.log(`[lifecycle] received ${signal}, draining (timeout ${drainTimeoutMs}ms)`);
    const timer = setTimeout(() => {
      console.error("[lifecycle] drain timeout exceeded — forcing exit");
      process.exit(1);
    }, drainTimeoutMs);
    timer.unref();
    try {
      for (const h of handlers.reverse()) {
        await h();
      }
      clearTimeout(timer);
      process.exit(0);
    } catch (err) {
      console.error("[lifecycle] shutdown handler failed:", err);
      process.exit(1);
    }
  };

  process.once("SIGTERM", () => void fire("SIGTERM"));
  process.once("SIGINT", () => void fire("SIGINT"));
  process.on("uncaughtException", (err) => {
    console.error("[lifecycle] uncaughtException:", err);
    void fire("uncaughtException");
  });
}
