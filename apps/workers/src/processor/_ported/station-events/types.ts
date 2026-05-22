export type StationEventConditionOperator =
  | "goes_above"
  | "goes_below"
  | "increments_up"
  | "increments_down"
  | "changes_to"
  | "any_change";

export interface StationEventTriggerCondition {
  id: string;
  kind: "condition";
  tagId: string;
  deviceId?: string;
  condition: StationEventConditionOperator;
  value: string | number | boolean | null;
}

export interface StationEventTriggerGroup {
  id: string;
  kind: "group";
  operator: "all" | "any";
  conditions: StationEventTriggerClause[];
}

export type StationEventTriggerClause = StationEventTriggerCondition | StationEventTriggerGroup;

export interface StationEventTrigger {
  operator: "all" | "any";
  clauses: StationEventTriggerClause[];
}

export interface StationEventAction {
  id: string;
  event: string;
  inputs: Record<string, unknown>;
  continueOnError?: boolean;
}

export interface StationEventDefinition {
  id: string;
  stationId: string;
  enabled: boolean;
  trigger: StationEventTrigger;
  actions: StationEventAction[];
}

export interface TagValueSnapshot {
  key: string;
  pointId: string;
  value: unknown;
  previousValue: unknown;
  quality?: "GOOD" | "BAD" | "UNKNOWN";
  timestamp?: string;
  gatewayTimestamp?: string;
  processorTimestamp?: string;
  observedAt: string;
  source: "stream" | "rpc";
}

export interface ProcessorTagSnapshotResponse {
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
}
