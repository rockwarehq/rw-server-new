// Shared BullMQ job-payload types.
//
// Producers live in apps/api; consumers live in apps/workers. Keeping these
// here is the type-safety bridge across the boundary. Fill in as each worker
// migrates.

export interface BucketEnsureJobPayload {
  // To be filled in during Phase 2 (rollups migration).
  scheduledAt: string;
}

export interface StationEventExecutionJobPayload {
  // To be filled in during Phase 2 (processor-consumer migration).
  stationId: string;
  eventId: string;
  triggerContext: unknown;
}
