import type { Logger } from "../pipeline/types.js";
import type {
  ProcessorTagSnapshotResponse,
  StationEventAction,
  StationEventDefinition,
  StationEventTrigger,
  StationEventTriggerClause,
} from "./types.js";

const TAG_REFERENCE_PATTERNS = [
  /\{\{\s*tagValues\.([a-zA-Z0-9:_-]+)\.(?:value|previousValue)\s*\}\}/g,
  /\{\{\s*tags\.([a-zA-Z0-9:_-]+)\.(?:value|previousValue)\s*\}\}/g,
];

export interface StationEventsRpcClient {
  listEventsForProcessor(input?: {
    stationId?: string;
  }): Promise<{ events: StationEventDefinition[] }>;
  getTagSnapshotsForProcessor(input: { tagKeys: string[] }): Promise<ProcessorTagSnapshotResponse>;
  triggerEvent(input: {
    stationId: string;
    eventId: string;
    payload: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface CompiledStationEvent {
  id: string;
  stationId: string;
  trigger: StationEventTrigger;
  actions: StationEventAction[];
  conditionKeys: Set<string>;
  actionTagKeys: Set<string>;
}

interface CompiledStationEventSnapshot {
  compiledById: Map<string, CompiledStationEvent>;
  candidateEventIdsByKey: Map<string, Set<string>>;
}

function clauseKey(clause: Extract<StationEventTriggerClause, { kind: "condition" }>): string {
  return clause.tagId;
}

function collectConditionKeys(
  clause: StationEventTriggerClause,
  conditionKeys: Set<string>,
  candidateEventIdsByKey: Map<string, Set<string>>,
  stationEventId: string,
) {
  if (clause.kind === "condition") {
    const key = clauseKey(clause);
    conditionKeys.add(key);
    const candidates = candidateEventIdsByKey.get(key) ?? new Set<string>();
    candidates.add(stationEventId);
    candidateEventIdsByKey.set(key, candidates);
    return;
  }

  for (const nested of clause.conditions) {
    collectConditionKeys(nested, conditionKeys, candidateEventIdsByKey, stationEventId);
  }
}

function collectTagReferencesFromUnknown(value: unknown, target: Set<string>) {
  if (typeof value === "string") {
    for (const pattern of TAG_REFERENCE_PATTERNS) {
      for (const match of value.matchAll(pattern)) {
        const key = match[1];
        if (key) {
          target.add(key);
        }
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectTagReferencesFromUnknown(item, target);
    }
    return;
  }

  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectTagReferencesFromUnknown(nested, target);
    }
  }
}

function collectActionTagKeys(actions: StationEventAction[]): Set<string> {
  const keys = new Set<string>();
  for (const action of actions) {
    collectTagReferencesFromUnknown(action.inputs, keys);
  }
  return keys;
}

function compileStationEvents(events: StationEventDefinition[]): CompiledStationEventSnapshot {
  const compiledById = new Map<string, CompiledStationEvent>();
  const candidateEventIdsByKey = new Map<string, Set<string>>();

  for (const event of events) {
    const conditionKeys = new Set<string>();
    for (const clause of event.trigger.clauses) {
      collectConditionKeys(clause, conditionKeys, candidateEventIdsByKey, event.id);
    }

    compiledById.set(event.id, {
      id: event.id,
      stationId: event.stationId,
      trigger: event.trigger,
      actions: event.actions,
      conditionKeys,
      actionTagKeys: collectActionTagKeys(event.actions),
    });
  }

  return {
    compiledById,
    candidateEventIdsByKey,
  };
}

export class StationEventCache {
  private snapshot: CompiledStationEventSnapshot = {
    compiledById: new Map(),
    candidateEventIdsByKey: new Map(),
  };
  private refreshPromise: Promise<void> | null = null;
  private refreshQueued = false;

  constructor(
    private readonly args: {
      logger: Logger;
      rpcClient: StationEventsRpcClient;
    },
  ) {}

  private async fetchAndSwapSnapshot() {
    const response = await this.args.rpcClient.listEventsForProcessor();
    const compiled = compileStationEvents(response.events);
    this.snapshot = compiled;
  }

  async loadInitialSnapshot(): Promise<void> {
    try {
      await this.fetchAndSwapSnapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.args.logger.error("failed to load station event cache snapshot", {
        cache: "station-events",
        error: message,
      });
      throw new Error(
        `failed to load station event cache snapshot: ${message}. Verify STATION_EVENTS_URL and PROCESSOR_SHARED_SECRET are configured correctly and the station events service is reachable.`,
      );
    }

    this.args.logger.info("station event cache initialized", {
      cache: "station-events",
      events: this.snapshot.compiledById.size,
      indexedKeys: this.snapshot.candidateEventIdsByKey.size,
    });
  }

  async refresh(reason: string): Promise<void> {
    if (this.refreshPromise) {
      this.refreshQueued = true;
      await this.refreshPromise;
      return;
    }

    this.refreshPromise = (async () => {
      let runAgain = false;
      do {
        this.refreshQueued = false;
        try {
          await this.fetchAndSwapSnapshot();
          this.args.logger.info("station event cache refreshed", {
            cache: "station-events",
            reason,
            events: this.snapshot.compiledById.size,
            indexedKeys: this.snapshot.candidateEventIdsByKey.size,
          });
        } catch (error) {
          this.args.logger.warn("station event cache refresh failed", {
            cache: "station-events",
            reason,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        runAgain = this.refreshQueued;
      } while (runAgain);
    })();

    try {
      await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  getCandidateEventIds(keys: Iterable<string>): string[] {
    const eventIds = new Set<string>();
    for (const key of keys) {
      const candidates = this.snapshot.candidateEventIdsByKey.get(key);
      if (!candidates) {
        continue;
      }
      for (const eventId of candidates) {
        eventIds.add(eventId);
      }
    }
    return Array.from(eventIds);
  }

  getCompiledEvent(eventId: string): CompiledStationEvent | undefined {
    return this.snapshot.compiledById.get(eventId);
  }

  getAllRequiredKeys(): string[] {
    const keys = new Set<string>();
    for (const event of this.snapshot.compiledById.values()) {
      for (const key of event.conditionKeys) {
        keys.add(key);
      }
      for (const key of event.actionTagKeys) {
        keys.add(key);
      }
    }

    return Array.from(keys);
  }
}
