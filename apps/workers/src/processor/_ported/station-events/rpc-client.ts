import { createProcessorRpcClient } from "./processor-rpc-client.js";

import type { StationEventsRpcClient } from "./station-event-cache.js";

export function createStationEventsRpcClient(args: {
  baseUrl: string;
  authToken: string;
}): StationEventsRpcClient {
  const client = createProcessorRpcClient({
    baseUrl: args.baseUrl,
    getSecret: () => args.authToken,
  }) as {
    station: {
      listEventsForProcessor(input?: { stationId?: string }): Promise<{
        events: Array<{
          id: string;
          stationId: string;
          enabled: boolean;
          trigger: {
            operator: "all" | "any";
            clauses: unknown[];
          };
          actions: Array<{
            id: string;
            event: string;
            inputs: Record<string, unknown>;
            continueOnError?: boolean;
          }>;
        }>;
      }>;
      getTagSnapshotsForProcessor(input: { tagKeys: string[] }): Promise<{
        snapshots: Record<
          string,
          {
            pointId: string;
            value: unknown;
            previousValue: unknown;
            quality?: "GOOD" | "BAD" | "UNKNOWN";
            timestamp?: string;
            gatewayTimestamp?: string;
            processorTimestamp?: string;
          }
        >;
      }>;
      triggerEvent(input: {
        stationId: string;
        eventId: string;
        payload: Record<string, unknown>;
      }): Promise<unknown>;
    };
  };

  return {
    listEventsForProcessor(input) {
      return client.station.listEventsForProcessor(input) as Promise<{
        events: import("./types.js").StationEventDefinition[];
      }>;
    },
    getTagSnapshotsForProcessor(input) {
      return client.station.getTagSnapshotsForProcessor(input);
    },
    triggerEvent(input) {
      return client.station.triggerEvent(input);
    },
  };
}
