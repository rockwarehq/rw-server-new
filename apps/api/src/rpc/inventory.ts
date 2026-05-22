import { z } from "zod";
import { ORPCError } from "@orpc/server";
import { authRequired, userOrDisplayRequired } from "./middleware.js";
import { material, inventory, product, materialLedger } from "@rw/services/inventory/index";
import { storageConfig } from "../config.js";

// ============================================================================
// Input Schemas - Inventory
// ============================================================================

const inventoryListInputSchema = z.object({
  siteId: z.uuid().optional(),
  cycleId: z.uuid().optional(),
  productBlobId: z.uuid().optional(),
  jobProductBlobId: z.uuid().optional(),
  dateFrom: z.coerce.date().optional(),
  dateTo: z.coerce.date().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const idInputSchema = z.object({
  id: z.uuid(),
});

const cycleIdInputSchema = z.object({
  cycleId: z.uuid(),
});

// ============================================================================
// Input Schemas - Material
// ============================================================================

const materialCreateInputSchema = z.object({
  siteId: z.uuid(),
  materialNumber: z.string().min(1),
  name: z.string().optional(),
  shortCode: z.string().optional(),
  description: z.string().optional(),
  externalNumber: z.string().optional(),
  weightUnits: z.enum(["KG", "LB", "G", "OZ"]).nullish(),
  unitCost: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const materialUpdateInputSchema = z.object({
  id: z.uuid(),
  materialNumber: z.string().min(1).optional(),
  name: z.string().optional(),
  shortCode: z.string().optional(),
  description: z.string().optional(),
  externalNumber: z.string().optional(),
  weightUnits: z.enum(["KG", "LB", "G", "OZ"]).nullish(),
  unitCost: z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]).nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const materialListInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  name: z.string().optional(),
  materialNumber: z.string().optional(),
  shortCode: z.string().optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures - Inventory
// ============================================================================

/**
 * List inventory items with optional filters
 */
export const inventoryList = authRequired.input(inventoryListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return inventory.list(input);
});

/**
 * Get inventory item by ID
 */
export const inventoryGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await inventory.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Inventory item not found" });
  }
  if ("error" in result) {
    const code = result.code as string;
    if (code === "INVENTORY_ITEM_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Get all inventory items from a specific cycle
 */
export const inventoryGetByCycle = authRequired.input(cycleIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await inventory.getByCycle(input.cycleId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "CYCLE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

// ============================================================================
// Procedures - Material
// ============================================================================

/**
 * Create a new material
 */
export const materialCreate = authRequired.input(materialCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await material.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * List materials with optional filters
 */
export const materialList = authRequired.input(materialListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  return material.list(input);
});

/**
 * Get material by ID
 */
export const materialGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await material.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Material not found" });
  }
  if ("error" in result) {
    const code = result.code as string;
    if (code === "MATERIAL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Update material (creates new blob version)
 */
export const materialUpdate = authRequired.input(materialUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const { id, ...updateData } = input;
  const result = await material.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "MATERIAL_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "MATERIAL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return result.data;
});

/**
 * Delete material (soft delete)
 */
export const materialRemove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Workspace context required",
    });
  }

  const result = await material.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "MATERIAL_NOT_FOUND" || code === "MATERIAL_DELETED") {
      throw new ORPCError("NOT_FOUND", {
        message: result.error as string,
        cause: result,
      });
    }
    if (code === "HAS_PRODUCTS") {
      throw new ORPCError("CONFLICT", {
        message: result.error as string,
        cause: result,
      });
    }
    throw new ORPCError("BAD_REQUEST", {
      message: result.error as string,
      cause: result,
    });
  }
  return { success: true };
});

// ============================================================================
// Input Schemas - Product
// ============================================================================

const weightUnitSchema = z.enum(["KG", "LB", "G", "OZ"]);

const productCreateInputSchema = z.object({
  siteId: z.uuid(),
  sku: z.string().min(1),
  name: z.string().optional(),
  description: z.string().optional(),
  externalSku: z.string().optional(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const productUpdateInputSchema = z.object({
  id: z.uuid(),
  sku: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  externalSku: z.string().optional(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
  attrs: z.record(z.string(), z.unknown()).optional(),
});

const productListInputSchema = z.object({
  siteId: z.uuid().optional(),
  q: z.string().optional(),
  sku: z.string().optional(),
  name: z.string().optional(),
  includeArchived: z.boolean().default(false),
  archivedOnly: z.boolean().default(false),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const productDuplicateInputSchema = z.object({
  id: z.uuid(),
  sku: z.string().min(1),
  name: z.string().optional(),
});

// Material management schemas
const productAddMaterialInputSchema = z.object({
  productId: z.uuid(),
  materialId: z.uuid(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
});

const productUpdateMaterialInputSchema = z.object({
  productId: z.uuid(),
  materialId: z.uuid(),
  weight: z.number().nonnegative().nullish(),
  weightUnits: weightUnitSchema.optional(),
  itemCost: z.number().nonnegative().nullish(),
});

const productRemoveMaterialInputSchema = z.object({
  productId: z.uuid(),
  materialId: z.uuid(),
  /** Required when removing the active of a multi-member alt group. */
  replaceActiveWithProductMaterialId: z.uuid().optional(),
});

const productIdInputSchema = z.object({
  productId: z.uuid(),
});

// Picture management schemas
const productAddPictureInputSchema = z.object({
  productId: z.uuid(),
  filename: z.string().min(1),
  contentType: z.string().refine((ct) => storageConfig.allowedContentTypes.includes(ct), {
    message: `Content type must be one of: ${storageConfig.allowedContentTypes.join(", ")}`,
  }),
  size: z
    .number()
    .int()
    .positive()
    .max(storageConfig.maxFileSizeBytes, {
      message: `File size must not exceed ${storageConfig.maxFileSizeBytes / (1024 * 1024)}MB`,
    }),
});

const productRemovePictureInputSchema = z.object({
  productId: z.uuid(),
  pictureId: z.uuid(),
});

const productSetPrimaryPictureInputSchema = z.object({
  productId: z.uuid(),
  pictureId: z.uuid(),
});

// ============================================================================
// Procedures - Product CRUD
// ============================================================================

/**
 * Create a new product
 */
export const productCreate = authRequired.input(productCreateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.create(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "SITE_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * List products with optional filters
 */
export const productList = authRequired.input(productListInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  return product.list(input);
});

/**
 * Get product by ID with materials, pictures, and primary picture URL
 */
export const productGet = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.getById(input.id);
  if (!result) {
    throw new ORPCError("NOT_FOUND", { message: "Product not found" });
  }
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Update product (creates new blob version)
 */
export const productUpdate = authRequired.input(productUpdateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const { id, ...updateData } = input;
  const result = await product.update(id, updateData);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND" || code === "PRODUCT_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Delete product (soft delete)
 */
export const productRemove = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.remove(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND" || code === "PRODUCT_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "HAS_JOB_PRODUCTS") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return { success: true };
});

// ============================================================================
// Procedures - Product Lifecycle
// ============================================================================

/**
 * Archive a product
 */
export const productArchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.archive(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND" || code === "PRODUCT_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "ALREADY_ARCHIVED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Unarchive a product
 */
export const productUnarchive = authRequired.input(idInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.unarchive(input.id);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND" || code === "PRODUCT_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    if (code === "NOT_ARCHIVED") {
      throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

/**
 * Duplicate a product with a new SKU
 */
export const productDuplicate = authRequired.input(productDuplicateInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.duplicate(input);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND" || code === "PRODUCT_DELETED") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

// ============================================================================
// Procedures - Product Materials
// ============================================================================

/**
 * Add a material to a product
 */
export const productAddMaterial = authRequired
  .input(productAddMaterialInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.addMaterial(input);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "PRODUCT_NOT_FOUND" || code === "MATERIAL_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "PRODUCT_DELETED" || code === "MATERIAL_DELETED") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "ALREADY_LINKED" || code === "SITE_MISMATCH") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Update a product-material link
 */
export const productUpdateMaterial = authRequired
  .input(productUpdateMaterialInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.updateMaterial(input);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "NOT_LINKED") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Remove a material from a product
 */
export const productRemoveMaterial = authRequired
  .input(productRemoveMaterialInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.removeMaterial(
      input.productId,
      input.materialId,
      input.replaceActiveWithProductMaterialId,
    );
    if ("error" in result) {
      const code = result.code as string;
      if (code === "NOT_LINKED") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "NEEDS_ACTIVE_SWAP" || code === "REPLACEMENT_NOT_IN_GROUP" || code === "REPLACEMENT_IS_SELF") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return { success: true };
  });

/**
 * List materials for a product
 */
export const productListMaterials = authRequired.input(productIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.listMaterials(input.productId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

// ============================================================================
// Procedures - Product Pictures
// ============================================================================

/**
 * Add a picture to a product (returns presigned upload URL)
 */
export const productAddPicture = authRequired
  .input(productAddPictureInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.addPicture(input);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "PRODUCT_NOT_FOUND" || code === "PRODUCT_DELETED") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "MAX_PICTURES_REACHED") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      if (code === "STORAGE_NOT_CONFIGURED" || code === "INVALID_UPLOAD") {
        throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Remove a picture from a product
 */
export const productRemovePicture = authRequired
  .input(productRemovePictureInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.removePicture(input.productId, input.pictureId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "PICTURE_NOT_FOUND" || code === "PICTURE_MISMATCH") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return { success: true };
  });

/**
 * Set a picture as the primary picture for a product
 */
export const productSetPrimaryPicture = authRequired
  .input(productSetPrimaryPictureInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.setPrimaryPicture(input.productId, input.pictureId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "PICTURE_NOT_FOUND" || code === "PICTURE_MISMATCH") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "ALREADY_PRIMARY") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return { success: true };
  });

/**
 * List pictures for a product with presigned download URLs
 */
export const productListPictures = authRequired.input(productIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.listPictures(input.productId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "PRODUCT_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

// ============================================================================
// Input Schemas - ProductMaterial Alt Groups
// ============================================================================

const productMaterialIdInputSchema = z.object({
  productMaterialId: z.uuid(),
});

const removeFromAltGroupInputSchema = z.object({
  productMaterialId: z.uuid(),
  /** Required when removing the active from a multi-member group. */
  replaceActiveWithProductMaterialId: z.uuid().optional(),
});

const altGroupIdInputSchema = z.object({
  altGroupId: z.uuid(),
});

const addMaterialToAltGroupInputSchema = z.object({
  altGroupId: z.uuid(),
  materialId: z.uuid(),
});

const setAltGroupActiveInputSchema = z.object({
  altGroupId: z.uuid(),
  productMaterialId: z.uuid(),
});

const updateAltGroupLabelInputSchema = z.object({
  altGroupId: z.uuid(),
  label: z.string().max(120).nullable(),
});

// ============================================================================
// Procedures - ProductMaterial Alt Groups
// ============================================================================

/**
 * Create a new unnamed alternate group around an existing ProductMaterial,
 * placing it as the first and active member.
 */
export const productCreateAltGroup = authRequired
  .input(productMaterialIdInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.createAltGroup(input.productMaterialId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "PRODUCT_MATERIAL_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "ALREADY_IN_GROUP") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Add a material to an alt group. If the material is already on the product,
 * moves the existing ProductMaterial into the group. Otherwise creates a new
 * ProductMaterial and places it in the group (not active).
 */
export const productAddMaterialToAltGroup = authRequired
  .input(addMaterialToAltGroupInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.addMaterialToAltGroup(input.altGroupId, input.materialId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "ALT_GROUP_NOT_FOUND" || code === "MATERIAL_NOT_FOUND" || code === "MATERIAL_DELETED") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "SITE_MISMATCH" || code === "IN_OTHER_GROUP") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Rename (or clear) an alt group's label.
 */
export const productUpdateAltGroupLabel = authRequired
  .input(updateAltGroupLabelInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.updateAltGroupLabel(input.altGroupId, input.label);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "ALT_GROUP_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "LABEL_CONFLICT") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Set which ProductMaterial is active in an alt group.
 *
 * Operators on the shop floor (display tokens) need this to swap to a
 * pre-approved alternate when stock runs out, so it accepts user OR display
 * principals. Group membership is the only authorization gate beyond that —
 * widening to include displays exposes no extra surface compared to the
 * read-side material list already available to the operator screen.
 */
export const productSetAltGroupActive = userOrDisplayRequired
  .input(setAltGroupActiveInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.setAltGroupActive(input.altGroupId, input.productMaterialId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "ALT_GROUP_NOT_FOUND" || code === "NOT_IN_GROUP") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Detach a ProductMaterial from its alt group (revert to standalone).
 *
 * If the PM is the group's active and the group has other members, the caller
 * must supply `replaceActiveWithProductMaterialId` — otherwise the server
 * returns `NEEDS_ACTIVE_SWAP` (HTTP 409). Last-member removal deletes the group.
 */
export const productRemoveFromAltGroup = authRequired
  .input(removeFromAltGroupInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await product.removeFromAltGroup(input.productMaterialId, input.replaceActiveWithProductMaterialId);
    if ("error" in result) {
      const code = result.code as string;
      if (code === "PRODUCT_MATERIAL_NOT_FOUND" || code === "NOT_IN_GROUP") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "NEEDS_ACTIVE_SWAP" || code === "REPLACEMENT_NOT_IN_GROUP" || code === "REPLACEMENT_IS_SELF") {
        throw new ORPCError("CONFLICT", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

/**
 * Delete an alt group: all members revert to standalone, then the group row
 * is removed.
 */
export const productDeleteAltGroup = authRequired.input(altGroupIdInputSchema).handler(async ({ input, context }) => {
  const workspaceId = context.iam.workspaceId;
  if (!workspaceId) {
    throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
  }

  const result = await product.deleteAltGroup(input.altGroupId);
  if ("error" in result) {
    const code = result.code as string;
    if (code === "ALT_GROUP_NOT_FOUND") {
      throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
    }
    throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
  }
  return result.data;
});

// ============================================================================
// Input Schemas - Material Ledger
// ============================================================================

const materialLedgerKindSchema = z.enum([
  "RECEIPT",
  "ADJUSTMENT",
  "WRITE_OFF",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "OPENING_BALANCE",
]);

// Accept numbers or numeric strings so high-precision decimals survive JSON.
const decimalInputSchema = z.union([z.number(), z.string().regex(/^-?\d+(\.\d+)?$/)]);

const materialLedgerCreateInputSchema = z.object({
  siteId: z.uuid(),
  materialId: z.uuid(),
  kind: materialLedgerKindSchema,
  quantity: decimalInputSchema,
  unit: weightUnitSchema,
  unitCost: decimalInputSchema.optional(),
  reference: z.string().max(255).optional(),
  note: z.string().max(2000).optional(),
});

const materialLedgerListInputSchema = z.object({
  siteId: z.uuid().optional(),
  materialId: z.uuid().optional(),
  kind: materialLedgerKindSchema.optional(),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

const dateStringSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD");

const materialLedgerUsageInputSchema = z.object({
  siteId: z.uuid(),
  workCenterId: z.uuid().optional(),
  startDate: dateStringSchema.optional(),
  endDate: dateStringSchema.optional(),
  groupByJob: z.boolean().default(true),
  groupByProduct: z.boolean().default(true),
  jobId: z.uuid().optional(),
  productId: z.uuid().optional(),
  materialId: z.uuid().optional(),
  sortBy: z.string().optional(),
  sortDir: z.enum(["asc", "desc"]).default("desc"),
  limit: z.number().min(0).default(50),
  offset: z.number().min(0).default(0),
});

// ============================================================================
// Procedures - Material Ledger
// ============================================================================

export const materialLedgerCreate = authRequired
  .input(materialLedgerCreateInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    const result = await materialLedger.create({
      siteId: input.siteId,
      materialId: input.materialId,
      kind: input.kind,
      quantity: input.quantity,
      unit: input.unit,
      unitCost: input.unitCost,
      reference: input.reference,
      note: input.note,
      performedByUserId: "id" in context.iam ? context.iam.id : null,
    });
    if ("error" in result) {
      const code = result.code as string;
      if (code === "MATERIAL_NOT_FOUND") {
        throw new ORPCError("NOT_FOUND", { message: result.error as string, cause: result });
      }
      if (code === "SITE_MISMATCH" || code === "INVALID_QUANTITY" || code === "INVALID_SIGN") {
        throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
      }
      throw new ORPCError("BAD_REQUEST", { message: result.error as string, cause: result });
    }
    return result.data;
  });

export const materialLedgerList = authRequired
  .input(materialLedgerListInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }

    return materialLedger.list(input);
  });

export const materialLedgerUsage = authRequired
  .input(materialLedgerUsageInputSchema)
  .handler(async ({ input, context }) => {
    const workspaceId = context.iam.workspaceId;
    if (!workspaceId) {
      throw new ORPCError("BAD_REQUEST", { message: "Workspace context required" });
    }
    return materialLedger.usage(input);
  });
