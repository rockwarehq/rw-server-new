import prisma from "@rw/db";
import {
  METRIC_CATALOG_REGISTRY,
  type MetricCatalogDefinition,
  type MetricCatalogEntityType,
  type MetricCatalogGranularity,
  type MetricCatalogValueType,
  type MetricCatalogDefaultAggregation,
} from "./registry.js";

export interface MetricCatalogItem {
  key: string;
  label: string;
  description?: string | null;
  unit?: string | null;
  valueType: MetricCatalogValueType;
  granularities: MetricCatalogGranularity[];
  entityTypes: MetricCatalogEntityType[];
  defaultAggregation?: MetricCatalogDefaultAggregation;
}

export interface ListMetricsInput {
  siteId: string;
  workspaceId: string;
  entityType?: MetricCatalogEntityType;
}

export type ListMetricsResult =
  | {
      success: true;
      data: MetricCatalogItem[];
    }
  | {
      success: false;
      code: "SITE_NOT_FOUND" | "WORKSPACE_MISMATCH";
      error: string;
    };

function toMetricCatalogItem(definition: MetricCatalogDefinition): MetricCatalogItem {
  return {
    ...definition,
    granularities: [...definition.granularities],
    entityTypes: [...definition.entityTypes],
  };
}

export function filterMetricCatalog(
  registry: readonly MetricCatalogDefinition[],
  entityType?: MetricCatalogEntityType,
): MetricCatalogItem[] {
  const definitions = entityType
    ? registry.filter((definition) => definition.entityTypes.includes(entityType))
    : registry;

  const sorted = [...definitions].sort((left, right) => {
    const labelOrder = left.label.localeCompare(right.label, undefined, { sensitivity: "base" });
    if (labelOrder !== 0) {
      return labelOrder;
    }

    return left.key.localeCompare(right.key, undefined, { sensitivity: "base" });
  });

  return sorted.map(toMetricCatalogItem);
}

export async function listMetrics(input: ListMetricsInput): Promise<ListMetricsResult> {
  const site = await prisma.site.findUnique({
    where: { id: input.siteId },
    select: { workspaceId: true },
  });

  if (!site) {
    return {
      success: false,
      code: "SITE_NOT_FOUND",
      error: "Site not found",
    };
  }

  if (site.workspaceId !== input.workspaceId) {
    return {
      success: false,
      code: "WORKSPACE_MISMATCH",
      error: "Site does not belong to this workspace",
    };
  }

  return {
    success: true,
    data: filterMetricCatalog(METRIC_CATALOG_REGISTRY, input.entityType),
  };
}
