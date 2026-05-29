import type { PrismaClient } from "@rw/db";
import {
  type IdMap,
  readData,
  batchUpsert,
  logger,
  parseNumber,
  isDevSeed,
} from "./utils.js";

// ---------------------------------------------------------------------------
// SQL Server source shape
// ---------------------------------------------------------------------------

interface SqlServerRow {
  PXID?: string;
  name: string;
  standardCycle: string;
  currentJob: string;
  slowDetect: string;
  downtimeDetect: string;
  inLineCalculations: string;
  ProcessType: string;
}

// ---------------------------------------------------------------------------
// Importer
// ---------------------------------------------------------------------------

export async function importStations(
  prisma: PrismaClient,
  idMap: IdMap,
  siteId: string,
): Promise<void> {
  const log = logger("Station");

  const rows = await readData<SqlServerRow>("Station");

  if (rows.length === 0) {
    log.warn("No Station data found in sqlLegacyData.txt — skipping");
    return;
  }

  log.info(`Found ${rows.length} rows to import`);

  // Track which jobs have been assigned to ensure no duplicates
  const assignedJobIds = new Set<string>();

  const result = await batchUpsert(
    rows,
    async (row) => {
      const name = row.name.trim();

      // Resolve workcenter:
      //  - New dumps: row.PXID is the FK to tblConfigLine.PXID (registered in
      //    IdMap by importWorkcenters).
      //  - Legacy dumps without PXID: fall back to the historical hard-coded
      //    "MOLD" lookup so older sqlLegacyData.txt files still import.
      let workcenterId: string | null;
      if (row.PXID) {
        workcenterId = idMap.get("workcenter", row.PXID) ?? null;
        if (!workcenterId) {
          log.warn(
            `Workcenter PXID "${row.PXID}" not found in IdMap for station "${name}" — setting workcenter to null`,
          );
        }
      } else {
        workcenterId = idMap.get("workcenter", "MOLD") ?? null;
      }

      // Handle decimal comma (e.g., "0,1" -> 0.1)
      const standardCycle = parseNumber(row.standardCycle);
      const slowDetect = parseNumber(row.slowDetect.replace(",", "."));
      const downtimeDetect = parseNumber(row.downtimeDetect);
      const inLineCalculations = row.inLineCalculations === "1";

      // Resolve currentJob from seed data. In dev-seed mode, fall back to any
      // unassigned job so every station has something to run; in real
      // `db:import` the source `currentJob` is taken at face value (NULL OK).
      const currentJobName = row.currentJob?.trim() || null;
      let currentJobId: string | null = null;
      if (currentJobName) {
        const jobId = idMap.get("job", currentJobName) ?? null;
        if (jobId && !assignedJobIds.has(jobId)) {
          currentJobId = jobId;
        }
      }
      if (!currentJobId && isDevSeed()) {
        const allJobIds = idMap.values("job");
        const available = allJobIds.find((id) => !assignedJobIds.has(id));
        if (available) {
          currentJobId = available;
        }
      }
      if (currentJobId) {
        assignedJobIds.add(currentJobId);
      }

      // Resolve processTypeId for the station blob
      const processTypeId = idMap.get("processType", row.ProcessType) ?? null;

      // Station has @@unique([siteId, name]); use findFirst with a
      // case-insensitive name match so re-imports treat e.g. "ARB35" / "arb35"
      // as the same station instead of creating a duplicate.
      const existing = await prisma.station.findFirst({
        where: { siteId, name: { equals: name, mode: "insensitive" } },
        include: { currentBlob: true },
      });

      let stationId: string;

      if (existing) {
        // Update station-level fields
        await prisma.station.update({
          where: { id: existing.id },
          data: { workcenterId, currentJobId },
        });

        const blob = existing.currentBlob;

        if (!blob) {
          // Existing station with no current blob — create v1.
          const newBlob = await prisma.stationBlob.create({
            data: {
              version: 1,
              standardCycle,
              downtimeDetect,
              slowDetect,
              inLineCalculations,
              processTypeId,
              stationId: existing.id,
            },
          });
          await prisma.station.update({
            where: { id: existing.id },
            data: { currentBlobId: newBlob.id },
          });
        } else {
          const changed =
            (blob.standardCycle !== null ? Number(blob.standardCycle) : null) !== standardCycle ||
            (blob.downtimeDetect !== null ? Number(blob.downtimeDetect) : null) !== downtimeDetect ||
            (blob.slowDetect !== null ? Number(blob.slowDetect) : null) !== slowDetect ||
            blob.inLineCalculations !== inLineCalculations ||
            blob.processTypeId !== processTypeId;

          if (changed) {
            await prisma.stationBlob.update({
              where: { id: blob.id },
              data: {
                standardCycle,
                downtimeDetect,
                slowDetect,
                inLineCalculations,
                processTypeId,
              },
            });
          }
        }

        stationId = existing.id;
      } else {
        // Create new station + blob v1
        const station = await prisma.station.create({
          data: {
            name,
            siteId,
            workcenterId,
            currentJobId,
          },
        });

        const blob = await prisma.stationBlob.create({
          data: {
            version: 1,
            standardCycle,
            downtimeDetect,
            slowDetect,
            inLineCalculations,
            processTypeId,
            stationId: station.id,
          },
        });

        await prisma.station.update({
          where: { id: station.id },
          data: { currentBlobId: blob.id },
        });

        stationId = station.id;
      }

      idMap.set("station", name, stationId);
    },
    { label: "stations" },
  );

  log.summary(result);
}
