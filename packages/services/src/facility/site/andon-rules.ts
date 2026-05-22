import type { Prisma } from "@rw/db";
import prisma from "@rw/db";

const MAX_EXPRESSION_LENGTH = 2000;
const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

type TransactionClient = Prisma.TransactionClient;

export interface AndonRuleRecord {
  id: string;
  siteId: string;
  name: string | null;
  expression: string;
  referencedVariables: string[];
  colorHex: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListAndonRulesInput {
  siteId: string;
}

export interface CreateAndonRuleInput {
  siteId: string;
  name?: string | null;
  expression: string;
  referencedVariables: string[];
  colorHex: string;
  enabled?: boolean;
}

export interface UpdateAndonRuleInput {
  id: string;
  name?: string | null;
  expression?: string;
  referencedVariables?: string[];
  colorHex?: string;
  enabled?: boolean;
}

export interface ReorderAndonRulesInput {
  siteId: string;
  orderedIds: string[];
}

type AuthorizedSiteResult =
  | { success: true }
  | { success: false; error: string; code: "SITE_NOT_FOUND" | "WORKSPACE_MISMATCH" };

function normalizeRuleName(name: string | null | undefined) {
  if (name === undefined || name === null) {
    return null;
  }

  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeExpression(expression: string) {
  return expression.trim();
}

function normalizeReferencedVariables(referencedVariables: readonly string[]) {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const variable of referencedVariables) {
    const trimmed = variable.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    normalized.push(trimmed);
  }

  return normalized;
}

function mapAndonRule(rule: {
  id: string;
  siteId: string;
  name: string | null;
  expression: string;
  referencedVariables: string[];
  colorHex: string;
  sortOrder: number;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}): AndonRuleRecord {
  return {
    id: rule.id,
    siteId: rule.siteId,
    name: rule.name,
    expression: rule.expression,
    referencedVariables: normalizeReferencedVariables(rule.referencedVariables),
    colorHex: rule.colorHex,
    sortOrder: rule.sortOrder,
    enabled: rule.enabled,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt,
  };
}

function validateExpression(expression: string) {
  if (!expression) {
    return "Expression cannot be empty";
  }

  if (expression.length > MAX_EXPRESSION_LENGTH) {
    return `Expression must be ${MAX_EXPRESSION_LENGTH} characters or fewer`;
  }

  return null;
}

function validateColorHex(colorHex: string) {
  if (!HEX_COLOR_PATTERN.test(colorHex)) {
    return "Color must be a valid #RRGGBB hex value";
  }

  return null;
}

function validateOrderedIds(orderedIds: readonly string[]) {
  if (orderedIds.length === 0) {
    return "Ordered IDs cannot be empty";
  }

  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (seen.has(id)) {
      return "Ordered IDs cannot contain duplicates";
    }

    seen.add(id);
  }

  return null;
}

async function validateSiteAccess(siteId: string, workspaceId: string): Promise<AuthorizedSiteResult> {
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { workspaceId: true },
  });

  if (!site) {
    return {
      success: false,
      code: "SITE_NOT_FOUND",
      error: "Site not found",
    };
  }

  if (site.workspaceId !== workspaceId) {
    return {
      success: false,
      code: "WORKSPACE_MISMATCH",
      error: "Site does not belong to this workspace",
    };
  }

  return { success: true };
}

async function compactSortOrder(tx: TransactionClient, siteId: string) {
  const rules = await tx.siteAndonRule.findMany({
    where: { siteId },
    select: { id: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  await Promise.all(
    rules.map((rule, index) =>
      tx.siteAndonRule.update({
        where: { id: rule.id },
        data: { sortOrder: index },
      }),
    ),
  );
}

export async function list(input: ListAndonRulesInput, workspaceId: string) {
  const siteAccess = await validateSiteAccess(input.siteId, workspaceId);
  if (!siteAccess.success) {
    return siteAccess;
  }

  const rules = await prisma.siteAndonRule.findMany({
    where: { siteId: input.siteId },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  return {
    data: rules.map(mapAndonRule),
  };
}

export async function create(input: CreateAndonRuleInput, workspaceId: string) {
  const siteAccess = await validateSiteAccess(input.siteId, workspaceId);
  if (!siteAccess.success) {
    return siteAccess;
  }

  const expression = normalizeExpression(input.expression);
  const expressionError = validateExpression(expression);
  if (expressionError) {
    return { error: expressionError, code: "INVALID_EXPRESSION" as const };
  }

  const colorHexError = validateColorHex(input.colorHex);
  if (colorHexError) {
    return { error: colorHexError, code: "INVALID_COLOR_HEX" as const };
  }

  const referencedVariables = normalizeReferencedVariables(input.referencedVariables);
  const maxSortOrder = await prisma.siteAndonRule.aggregate({
    where: { siteId: input.siteId },
    _max: { sortOrder: true },
  });

  const rule = await prisma.siteAndonRule.create({
    data: {
      siteId: input.siteId,
      name: normalizeRuleName(input.name),
      expression,
      referencedVariables,
      colorHex: input.colorHex,
      enabled: input.enabled ?? true,
      sortOrder: (maxSortOrder._max.sortOrder ?? -1) + 1,
    },
  });

  return { data: mapAndonRule(rule) };
}

export async function update(input: UpdateAndonRuleInput, workspaceId: string) {
  const current = await prisma.siteAndonRule.findUnique({
    where: { id: input.id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Andon rule not found", code: "RULE_NOT_FOUND" as const };
  }

  if (current.site.workspaceId !== workspaceId) {
    return { error: "Andon rule does not belong to this workspace", code: "WORKSPACE_MISMATCH" as const };
  }

  const updateData: {
    name?: string | null;
    expression?: string;
    referencedVariables?: string[];
    colorHex?: string;
    enabled?: boolean;
  } = {};

  if (input.name !== undefined) {
    updateData.name = normalizeRuleName(input.name);
  }

  if (input.expression !== undefined) {
    const expression = normalizeExpression(input.expression);
    const expressionError = validateExpression(expression);
    if (expressionError) {
      return { error: expressionError, code: "INVALID_EXPRESSION" as const };
    }

    updateData.expression = expression;
  }

  if (input.referencedVariables !== undefined) {
    updateData.referencedVariables = normalizeReferencedVariables(input.referencedVariables);
  }

  if (input.colorHex !== undefined) {
    const colorHexError = validateColorHex(input.colorHex);
    if (colorHexError) {
      return { error: colorHexError, code: "INVALID_COLOR_HEX" as const };
    }

    updateData.colorHex = input.colorHex;
  }

  if (input.enabled !== undefined) {
    updateData.enabled = input.enabled;
  }

  if (Object.keys(updateData).length === 0) {
    return { data: mapAndonRule(current) };
  }

  const rule = await prisma.siteAndonRule.update({
    where: { id: input.id },
    data: updateData,
  });

  return { data: mapAndonRule(rule) };
}

export async function remove(id: string, workspaceId: string) {
  const current = await prisma.siteAndonRule.findUnique({
    where: { id },
    include: {
      site: {
        select: { workspaceId: true },
      },
    },
  });

  if (!current) {
    return { error: "Andon rule not found", code: "RULE_NOT_FOUND" as const };
  }

  if (current.site.workspaceId !== workspaceId) {
    return { error: "Andon rule does not belong to this workspace", code: "WORKSPACE_MISMATCH" as const };
  }

  await prisma.$transaction(async (tx) => {
    await tx.siteAndonRule.delete({ where: { id } });
    await compactSortOrder(tx, current.siteId);
  });

  return { success: true };
}

export async function reorder(input: ReorderAndonRulesInput, workspaceId: string) {
  const siteAccess = await validateSiteAccess(input.siteId, workspaceId);
  if (!siteAccess.success) {
    return siteAccess;
  }

  const orderedIdsError = validateOrderedIds(input.orderedIds);
  if (orderedIdsError) {
    return { error: orderedIdsError, code: "INVALID_ORDER" as const };
  }

  const existingRules = await prisma.siteAndonRule.findMany({
    where: { siteId: input.siteId },
    select: { id: true },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });

  if (existingRules.length !== input.orderedIds.length) {
    return { error: "Ordered IDs must include every rule for the site", code: "INVALID_ORDER" as const };
  }

  const existingIds = new Set(existingRules.map((rule) => rule.id));
  for (const id of input.orderedIds) {
    if (!existingIds.has(id)) {
      return { error: "Ordered IDs must include only rules from the target site", code: "INVALID_ORDER" as const };
    }
  }

  await prisma.$transaction(
    input.orderedIds.map((id, index) =>
      prisma.siteAndonRule.update({
        where: { id },
        data: { sortOrder: index },
      }),
    ),
  );

  return { success: true };
}
