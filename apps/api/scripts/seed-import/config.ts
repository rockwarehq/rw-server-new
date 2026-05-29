// ---------------------------------------------------------------------------
// Import configuration
//
// All settings for the SQL Server -> Postgres data import live here.
// Adjust these values for your target environment before running.
// ---------------------------------------------------------------------------

export interface ImportConfig {
  /** Name of the target Site in Postgres to import data into. */
  siteName: string;

  /** Workspace name the site belongs to (used for lookup validation). */
  workspaceName: string;

  /** Number of rows to process before logging progress. */
  batchSize: number;

  /** If true, log each individual row as it's processed. */
  verbose: boolean;
}

const config: ImportConfig = {
  siteName: "Rockware",
  workspaceName: "Default",
  batchSize: 500,
  verbose: false,
};

export default config;
