import prisma from "@rw/db";
import type { Prisma, WeightUnit } from "@rw/db";

import * as storage from "@rw/infra/storage";

// ============================================================================
// Types - Product CRUD
// ============================================================================

export interface CreateProductInput {
  siteId: string;
  sku: string;
  name?: string;
  description?: string;
  externalSku?: string;
  weight?: number | null;
  weightUnits?: WeightUnit;
  itemCost?: number | null;
  attrs?: Record<string, unknown>;
}

export interface UpdateProductInput {
  sku?: string;
  name?: string;
  description?: string;
  externalSku?: string;
  weight?: number | null;
  weightUnits?: WeightUnit;
  itemCost?: number | null;
  attrs?: Record<string, unknown>;
}

export interface ListProductsFilter {
  siteId?: string;
  /** Free-text search across sku and name (case-insensitive contains, OR) */
  q?: string;
  sku?: string;
  name?: string;
  includeArchived?: boolean;
  archivedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export interface DuplicateProductInput {
  id: string;
  sku: string;
  name?: string;
}

// ============================================================================
// Types - Material Operations
// ============================================================================

export interface AddMaterialInput {
  productId: string;
  materialId: string;
  weight?: number | null;
  weightUnits?: WeightUnit;
  itemCost?: number | null;
}

export interface UpdateMaterialInput {
  productId: string;
  materialId: string;
  weight?: number | null;
  weightUnits?: WeightUnit;
  itemCost?: number | null;
}

// ============================================================================
// Types - Picture Operations
// ============================================================================

export interface AddPictureInput {
  productId: string;
  filename: string;
  contentType: string;
  size: number;
}

// ============================================================================
// Product CRUD Operations
// ============================================================================

/**
 * Create a new product with initial blob (version 1)
 */
export async function create(input: CreateProductInput) {
  const { siteId, sku, name, description, externalSku, weight, weightUnits, itemCost, attrs } = input;

  // Verify site exists
  const site = await prisma.site.findUnique({
    where: { id: siteId },
    select: { id: true },
  });

  if (!site) {
    return { error: "Site not found", code: "SITE_NOT_FOUND" };
  }

  // Create product and initial blob in transaction
  const product = await prisma.$transaction(async (tx) => {
    // 1. Create Product entity
    const p = await tx.product.create({
      data: { siteId },
    });

    // 2. Create initial ProductBlob (version 1)
    const blob = await tx.productBlob.create({
      data: {
        productId: p.id,
        version: 1,
        sku,
        name: name ?? null,
        description: description ?? null,
        externalSku: externalSku ?? null,
        weight: weight ?? null,
        weightUnits: weightUnits ?? null,
        itemCost: itemCost ?? null,
        attrs: attrs ?? {},
      },
    });

    // 3. Link blob as current and return
    return tx.product.update({
      where: { id: p.id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
      },
    });
  });

  return { data: product };
}

/**
 * List products with optional filtering
 */
export async function list(filter: ListProductsFilter = {}) {
  const { siteId, q, sku, name, includeArchived = false, archivedOnly = false, limit = 50, offset = 0 } = filter;

  const where: Prisma.ProductWhereInput = {
    deletedAt: null,
  };

  // Archive filtering
  if (archivedOnly) {
    where.archivedAt = { not: null };
  } else if (!includeArchived) {
    where.archivedAt = null;
  }

  if (siteId) {
    where.siteId = siteId;
  }

  // Free-text search OR'd across the columns shown in the UI.
  if (q) {
    where.currentBlob = {
      OR: [{ sku: { contains: q, mode: "insensitive" } }, { name: { contains: q, mode: "insensitive" } }],
    };
  } else if (sku || name) {
    where.currentBlob = {};
    if (sku) {
      where.currentBlob.sku = { contains: sku, mode: "insensitive" };
    }
    if (name) {
      where.currentBlob.name = { contains: name, mode: "insensitive" };
    }
  }

  const [products, total] = await Promise.all([
    prisma.product.findMany({
      where,
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
      },
      ...(Number(limit) > 0 ? { take: Number(limit) } : {}),
      skip: Number(offset),
      orderBy: { createdAt: "desc" },
    }),
    prisma.product.count({ where }),
  ]);

  return {
    data: products,
    total,
    limit: Number(limit),
    offset: Number(offset),
  };
}

/**
 * Get product by ID with current blob, materials, pictures, and primary picture URL
 */
export async function getById(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      currentBlob: true,
      site: { select: { id: true, name: true } },
      materials: {
        include: {
          currentBlob: true,
          material: {
            include: {
              currentBlob: true,
            },
          },
          altGroup: {
            select: { id: true, label: true, activeProductMaterialId: true },
          },
        },
      },
      pictures: {
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      },
      _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
    },
  });

  if (!product) {
    return null;
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  // Generate presigned URLs for all pictures in parallel.
  const pictures = await Promise.all(
    product.pictures.map(async (pic) => {
      let url: string | null = null;
      if (storage.isStorageEnabled()) {
        try {
          url = await storage.getPresignedDownloadUrl(pic.key);
        } catch {
          // Storage error - continue without URL
        }
      }
      return { ...pic, url };
    }),
  );

  const primaryPictureUrl = pictures.find((p) => p.isPrimary)?.url ?? null;

  return {
    data: {
      ...product,
      pictures,
      primaryPictureUrl,
    },
  };
}

/**
 * Update product (creates new blob version)
 */
export async function update(id: string, input: UpdateProductInput) {
  const { sku, name, description, externalSku, weight, weightUnits, itemCost, attrs } = input;

  // Get current product with blob
  const current = await prisma.product.findUnique({
    where: { id },
    include: { currentBlob: true },
  });

  if (!current) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (current.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  if (!current.currentBlob) {
    return { error: "Product has no current blob", code: "NO_CURRENT_BLOB" };
  }

  const currentBlob = current.currentBlob;

  // Get next version number
  const latestBlob = await prisma.productBlob.findFirst({
    where: { productId: id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestBlob?.version ?? 0) + 1;

  // Create new blob with merged data
  const product = await prisma.$transaction(async (tx) => {
    const blob = await tx.productBlob.create({
      data: {
        productId: id,
        version: nextVersion,
        sku: sku ?? currentBlob.sku,
        name: name !== undefined ? name : currentBlob.name,
        description: description !== undefined ? description : currentBlob.description,
        externalSku: externalSku !== undefined ? externalSku : currentBlob.externalSku,
        weight: weight !== undefined ? weight : currentBlob.weight,
        weightUnits: weightUnits !== undefined ? weightUnits : currentBlob.weightUnits,
        itemCost: itemCost !== undefined ? itemCost : currentBlob.itemCost,
        attrs: attrs !== undefined ? attrs : (currentBlob.attrs as Record<string, unknown>),
      },
    });

    return tx.product.update({
      where: { id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
      },
    });
  });

  return { data: product };
}

/**
 * Soft delete product (sets deletedAt)
 */
export async function remove(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    include: {
      _count: { select: { jobProducts: true } },
    },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product already deleted", code: "PRODUCT_DELETED" };
  }

  if (product._count.jobProducts > 0) {
    return {
      error: "Cannot delete product that is linked to jobs. Remove from jobs first.",
      code: "HAS_JOB_PRODUCTS",
    };
  }

  await prisma.product.update({
    where: { id },
    data: { deletedAt: new Date() },
  });

  return { success: true };
}

/**
 * Check if product exists
 */
export async function exists(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, deletedAt: true },
  });
  return product !== null && product.deletedAt === null;
}

/**
 * Get product version history (all blobs)
 */
export async function getVersionHistory(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, currentBlobId: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  const blobs = await prisma.productBlob.findMany({
    where: { productId: id },
    orderBy: { version: "desc" },
  });

  return {
    data: blobs.map((blob) => ({
      ...blob,
      isCurrent: blob.id === product.currentBlobId,
    })),
  };
}

// ============================================================================
// Product Lifecycle Operations
// ============================================================================

/**
 * Archive a product (sets archivedAt timestamp)
 */
export async function archive(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, archivedAt: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  if (product.archivedAt) {
    return { error: "Product is already archived", code: "ALREADY_ARCHIVED" };
  }

  const updated = await prisma.product.update({
    where: { id },
    data: { archivedAt: new Date() },
    include: {
      currentBlob: true,
      site: { select: { id: true, name: true } },
      _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
    },
  });

  return { data: updated };
}

/**
 * Unarchive a product (clears archivedAt timestamp)
 */
export async function unarchive(id: string) {
  const product = await prisma.product.findUnique({
    where: { id },
    select: { id: true, deletedAt: true, archivedAt: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  if (!product.archivedAt) {
    return { error: "Product is not archived", code: "NOT_ARCHIVED" };
  }

  const updated = await prisma.product.update({
    where: { id },
    data: { archivedAt: null },
    include: {
      currentBlob: true,
      site: { select: { id: true, name: true } },
      _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
    },
  });

  return { data: updated };
}

/**
 * Duplicate a product with a new SKU
 * Copies current blob data, materials, and picture references (shared S3 keys)
 */
export async function duplicate(input: DuplicateProductInput) {
  const { id, sku, name } = input;

  // Get source product with all related data
  const source = await prisma.product.findUnique({
    where: { id },
    include: {
      currentBlob: true,
      materials: {
        include: {
          currentBlob: true,
          material: { select: { currentBlobId: true } },
        },
      },
      pictures: true,
    },
  });

  if (!source) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (source.deletedAt) {
    return { error: "Cannot duplicate a deleted product", code: "PRODUCT_DELETED" };
  }

  if (!source.currentBlob) {
    return { error: "Product has no current blob", code: "NO_CURRENT_BLOB" };
  }

  const sourceBlob = source.currentBlob;
  const sourceMaterials: Array<(typeof source.materials)[number] & { materialBlobId: string }> = [];
  for (const material of source.materials) {
    const materialBlobId = material.material.currentBlobId;
    if (!materialBlobId) {
      return { error: "Material has no current blob", code: "NO_CURRENT_BLOB" };
    }
    sourceMaterials.push({ ...material, materialBlobId });
  }

  // Create duplicate in transaction
  const product = await prisma.$transaction(async (tx) => {
    // 1. Create new Product entity
    const p = await tx.product.create({
      data: { siteId: source.siteId },
    });

    // 2. Create new ProductBlob (version 1) with source data
    const defaultName = name ?? `Copy of ${sourceBlob.name || sourceBlob.sku}`;
    const blob = await tx.productBlob.create({
      data: {
        productId: p.id,
        version: 1,
        sku, // New SKU (required)
        name: defaultName,
        description: sourceBlob.description,
        externalSku: sourceBlob.externalSku,
        weight: sourceBlob.weight,
        weightUnits: sourceBlob.weightUnits,
        itemCost: sourceBlob.itemCost,
        attrs: sourceBlob.attrs as Record<string, unknown>,
      },
    });

    // 3. Link blob as current
    await tx.product.update({
      where: { id: p.id },
      data: { currentBlobId: blob.id },
    });

    // 4. Copy ProductMaterial links with initial blobs
    for (const m of sourceMaterials) {
      const pm = await tx.productMaterial.create({
        data: {
          productId: p.id,
          materialId: m.materialId,
          attrs: m.attrs as Record<string, unknown>,
        },
      });

      const pmBlob = await tx.productMaterialBlob.create({
        data: {
          productMaterialId: pm.id,
          version: 1,
          weight: m.currentBlob?.weight ?? null,
          weightUnits: m.currentBlob?.weightUnits ?? null,
          itemCost: m.currentBlob?.itemCost ?? null,
          materialBlobId: m.materialBlobId,
          productBlobId: blob.id,
        },
      });

      await tx.productMaterial.update({
        where: { id: pm.id },
        data: { currentBlobId: pmBlob.id },
      });
    }

    // 5. Copy ProductPicture records (shared S3 keys - no file duplication)
    if (source.pictures.length > 0) {
      await tx.productPicture.createMany({
        data: source.pictures.map((pic) => ({
          productId: p.id,
          key: pic.key, // Same S3 key - shared storage
          filename: pic.filename,
          contentType: pic.contentType,
          size: pic.size,
          isPrimary: pic.isPrimary,
        })),
      });
    }

    // Return the new product with all includes
    return tx.product.findUnique({
      where: { id: p.id },
      include: {
        currentBlob: true,
        site: { select: { id: true, name: true } },
        _count: { select: { materials: true, jobProducts: true, blobs: true, pictures: true } },
      },
    });
  });

  return { data: product };
}

// ============================================================================
// Material Operations
// ============================================================================

/**
 * Add a material to a product
 */
export async function addMaterial(input: AddMaterialInput) {
  const { productId, materialId, weight, weightUnits, itemCost } = input;

  // Verify product exists and is not deleted
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, siteId: true, deletedAt: true, currentBlobId: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  // Verify material exists and is not deleted
  const material = await prisma.material.findUnique({
    where: { id: materialId },
    select: { id: true, siteId: true, deletedAt: true, currentBlobId: true },
  });

  if (!material) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }

  if (material.deletedAt) {
    return { error: "Material has been deleted", code: "MATERIAL_DELETED" };
  }

  // Verify same site
  if (product.siteId !== material.siteId) {
    return { error: "Product and material must belong to the same site", code: "SITE_MISMATCH" };
  }

  // Check if already linked
  const existing = await prisma.productMaterial.findUnique({
    where: { productId_materialId: { productId, materialId } },
  });

  if (existing) {
    return { error: "Material is already linked to this product", code: "ALREADY_LINKED" };
  }

  const productBlobId = product.currentBlobId;
  const materialBlobId = material.currentBlobId;
  if (!productBlobId || !materialBlobId) {
    return { error: "Material or product has no current blob", code: "NO_CURRENT_BLOB" };
  }

  // Create link and initial blob in transaction
  const productMaterial = await prisma.$transaction(async (tx) => {
    const pm = await tx.productMaterial.create({
      data: {
        productId,
        materialId,
      },
    });

    const blob = await tx.productMaterialBlob.create({
      data: {
        productMaterialId: pm.id,
        version: 1,
        weight: weight ?? null,
        weightUnits: weightUnits ?? null,
        itemCost: itemCost ?? null,
        materialBlobId,
        productBlobId,
      },
    });

    return tx.productMaterial.update({
      where: { id: pm.id },
      data: { currentBlobId: blob.id },
      include: {
        currentBlob: true,
        material: {
          include: {
            currentBlob: true,
          },
        },
      },
    });
  });

  return { data: productMaterial };
}

/**
 * Update a product-material link
 */
export async function updateMaterial(input: UpdateMaterialInput) {
  const { productId, materialId, weight, weightUnits, itemCost } = input;

  // Find existing link with current blob and parent entities for blob snapshots
  const existing = await prisma.productMaterial.findUnique({
    where: { productId_materialId: { productId, materialId } },
    include: {
      currentBlob: true,
      product: { select: { currentBlobId: true } },
      material: { select: { currentBlobId: true } },
    },
  });

  if (!existing) {
    return { error: "Material is not linked to this product", code: "NOT_LINKED" };
  }

  const materialBlobId = existing.material.currentBlobId;
  const productBlobId = existing.product.currentBlobId;
  if (!materialBlobId || !productBlobId) {
    return { error: "Material or product has no current blob", code: "NO_CURRENT_BLOB" };
  }

  // Get next version number
  const latestBlob = await prisma.productMaterialBlob.findFirst({
    where: { productMaterialId: existing.id },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  const nextVersion = (latestBlob?.version ?? 0) + 1;

  // Create new blob version
  const productMaterial = await prisma.$transaction(async (tx) => {
    const currentBlob = existing.currentBlob;
    const newWeight = weight !== undefined ? weight : (currentBlob?.weight ?? null);
    const newWeightUnits = weightUnits !== undefined ? weightUnits : (currentBlob?.weightUnits ?? null);
    const newItemCost = itemCost !== undefined ? itemCost : (currentBlob?.itemCost ?? null);

    const blob = await tx.productMaterialBlob.create({
      data: {
        productMaterialId: existing.id,
        version: nextVersion,
        weight: newWeight,
        weightUnits: newWeightUnits,
        itemCost: newItemCost,
        materialBlobId,
        productBlobId,
      },
    });

    return tx.productMaterial.update({
      where: { id: existing.id },
      data: {
        currentBlobId: blob.id,
      },
      include: {
        currentBlob: true,
        material: {
          include: {
            currentBlob: true,
          },
        },
      },
    });
  });

  return { data: productMaterial };
}

/**
 * Remove a material from a product (hard delete of the ProductMaterial row).
 *
 * If the PM is the active member of a multi-member alt group, the caller must
 * supply `replaceActiveWithProductMaterialId` to promote another member first
 * — otherwise `NEEDS_ACTIVE_SWAP` is returned so the UI can prompt. Deleting
 * the last member of a group also deletes the group row. Non-group or
 * non-active removals behave as before.
 *
 * Errors:
 *   NOT_LINKED               - no ProductMaterial for this (product, material)
 *   NEEDS_ACTIVE_SWAP        - active in multi-member group with no replacement supplied
 *   REPLACEMENT_NOT_IN_GROUP - replacement isn't a member of the same group
 *   REPLACEMENT_IS_SELF      - replacement equals the PM being removed
 */
export async function removeMaterial(
  productId: string,
  materialId: string,
  replaceActiveWithProductMaterialId?: string,
) {
  const existing = await prisma.productMaterial.findUnique({
    where: { productId_materialId: { productId, materialId } },
    select: {
      id: true,
      altGroupId: true,
      activeOfAltGroup: { select: { id: true } },
    },
  });

  if (!existing) {
    return { error: "Material is not linked to this product", code: "NOT_LINKED" };
  }

  const altGroupId = existing.altGroupId;
  const isActive = !!existing.activeOfAltGroup;
  const peerCount = altGroupId
    ? await prisma.productMaterial.count({ where: { altGroupId, id: { not: existing.id } } })
    : 0;

  // Validate replacement (when provided) or require one for ambiguous removals.
  if (replaceActiveWithProductMaterialId) {
    if (replaceActiveWithProductMaterialId === existing.id) {
      return { error: "Replacement cannot be the material being removed", code: "REPLACEMENT_IS_SELF" };
    }
    const replacement = await prisma.productMaterial.findUnique({
      where: { id: replaceActiveWithProductMaterialId },
      select: { id: true, altGroupId: true },
    });
    if (!replacement || replacement.altGroupId !== altGroupId) {
      return {
        error: "Replacement product material is not a member of this group",
        code: "REPLACEMENT_NOT_IN_GROUP",
      };
    }
  } else if (altGroupId && isActive && peerCount > 0) {
    return {
      error: "This is the active material in a multi-member group — choose another to make active first",
      code: "NEEDS_ACTIVE_SWAP",
    };
  }

  await prisma.$transaction(async (tx) => {
    if (altGroupId && isActive && peerCount > 0) {
      // Promote replacement to active before deleting this PM — keeps the
      // "exactly one active per non-empty group" invariant unbroken.
      await tx.productMaterialAltGroup.update({
        where: { id: altGroupId },
        // biome-ignore lint/style/noNonNullAssertion: NEEDS_ACTIVE_SWAP returned earlier if replaceActiveWithProductMaterialId is missing when isActive && peerCount > 0
        data: { activeProductMaterialId: replaceActiveWithProductMaterialId! },
      });
    }
    await tx.productMaterial.delete({
      where: { productId_materialId: { productId, materialId } },
    });
    if (altGroupId && peerCount === 0) {
      // Last member deleted — clean up the now-empty group row.
      await tx.productMaterialAltGroup.delete({ where: { id: altGroupId } });
    }
  });

  return { success: true };
}

/**
 * List materials for a product
 */
export async function listMaterials(productId: string) {
  // Verify product exists
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, deletedAt: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  const materials = await prisma.productMaterial.findMany({
    where: { productId },
    include: {
      material: {
        include: {
          currentBlob: true,
        },
      },
      altGroup: {
        select: { id: true, label: true, activeProductMaterialId: true },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return { data: materials };
}

// ============================================================================
// ProductMaterial Alternate Group Operations
// ============================================================================

const altGroupInclude = {
  options: {
    include: {
      material: { include: { currentBlob: true } },
      currentBlob: true,
    },
    orderBy: { createdAt: "asc" },
  },
} as const;

/**
 * Create a new unnamed alternate group, place `productMaterialId` in it, and
 * mark it as the active option. Used when a user right-clicks an existing
 * ProductMaterial and chooses "add alternate material" — the clicked PM
 * becomes the first member and the active one.
 *
 * Errors:
 *   PRODUCT_MATERIAL_NOT_FOUND - productMaterialId doesn't exist
 *   ALREADY_IN_GROUP           - PM already belongs to an alt group
 */
export async function createAltGroup(productMaterialId: string) {
  const pm = await prisma.productMaterial.findUnique({
    where: { id: productMaterialId },
    select: { id: true, productId: true, altGroupId: true },
  });

  if (!pm) {
    return { error: "Product material not found", code: "PRODUCT_MATERIAL_NOT_FOUND" };
  }

  if (pm.altGroupId) {
    return { error: "Product material is already in an alternate group", code: "ALREADY_IN_GROUP" };
  }

  const group = await prisma.$transaction(async (tx) => {
    const created = await tx.productMaterialAltGroup.create({
      data: { productId: pm.productId },
    });
    await tx.productMaterial.update({
      where: { id: pm.id },
      data: { altGroupId: created.id },
    });
    return tx.productMaterialAltGroup.update({
      where: { id: created.id },
      data: { activeProductMaterialId: pm.id },
      include: altGroupInclude,
    });
  });

  return { data: group };
}

/**
 * Add a material to an existing alt group.
 *
 * Two paths:
 *   - If the material is already a standalone ProductMaterial on the same
 *     product (not in any group), move that existing row into the group,
 *     preserving its blob history and any archivedAt state.
 *   - Else, create a new ProductMaterial + initial blob in the group.
 *
 * Rejects cross-group moves: if the material already belongs to a different
 * alt group on this product, the caller must first `removeFromAltGroup` it.
 * This keeps the "one group per material" invariant explicit rather than
 * silently swapping group membership.
 *
 * The new/moved PM is not automatically activated — callers use
 * `setAltGroupActive` to swap.
 *
 * Errors:
 *   ALT_GROUP_NOT_FOUND - group doesn't exist
 *   MATERIAL_NOT_FOUND  - material doesn't exist
 *   MATERIAL_DELETED    - material is soft-deleted
 *   SITE_MISMATCH       - material belongs to a different site than the product
 *   IN_OTHER_GROUP      - material is already in a different alt group on this product
 *   NO_CURRENT_BLOB     - material or product has no current blob to snapshot
 */
export async function addMaterialToAltGroup(altGroupId: string, materialId: string) {
  const group = await prisma.productMaterialAltGroup.findUnique({
    where: { id: altGroupId },
    select: {
      id: true,
      productId: true,
      product: { select: { id: true, siteId: true, currentBlobId: true, deletedAt: true } },
    },
  });

  if (!group || group.product.deletedAt) {
    return { error: "Alternate group not found", code: "ALT_GROUP_NOT_FOUND" };
  }

  const material = await prisma.material.findUnique({
    where: { id: materialId },
    select: { id: true, siteId: true, deletedAt: true, currentBlobId: true },
  });

  if (!material) {
    return { error: "Material not found", code: "MATERIAL_NOT_FOUND" };
  }
  if (material.deletedAt) {
    return { error: "Material has been deleted", code: "MATERIAL_DELETED" };
  }
  if (material.siteId !== group.product.siteId) {
    return { error: "Product and material must belong to the same site", code: "SITE_MISMATCH" };
  }

  // Is the material already linked to this product as a ProductMaterial?
  const existing = await prisma.productMaterial.findUnique({
    where: { productId_materialId: { productId: group.productId, materialId } },
    select: { id: true, altGroupId: true },
  });

  if (existing?.altGroupId && existing.altGroupId !== altGroupId) {
    return {
      error: "Material is already in a different alternate group on this product",
      code: "IN_OTHER_GROUP",
    };
  }

  const updated = await prisma
    .$transaction(async (tx) => {
      if (existing) {
        // Standalone PM or already in this group — move/keep it.
        if (existing.altGroupId !== altGroupId) {
          await tx.productMaterial.update({
            where: { id: existing.id },
            data: { altGroupId },
          });
        }
      } else {
        if (!material.currentBlobId || !group.product.currentBlobId) {
          throw new Error("NO_CURRENT_BLOB");
        }
        const pm = await tx.productMaterial.create({
          data: { productId: group.productId, materialId, altGroupId },
        });
        const blob = await tx.productMaterialBlob.create({
          data: {
            productMaterialId: pm.id,
            version: 1,
            materialBlobId: material.currentBlobId,
            productBlobId: group.product.currentBlobId,
          },
        });
        await tx.productMaterial.update({
          where: { id: pm.id },
          data: { currentBlobId: blob.id },
        });
      }

      return tx.productMaterialAltGroup.findUnique({
        where: { id: altGroupId },
        include: altGroupInclude,
      });
    })
    .catch((err: Error) => {
      if (err.message === "NO_CURRENT_BLOB") {
        return { error: "Material or product has no current blob", code: "NO_CURRENT_BLOB" } as const;
      }
      throw err;
    });

  if (updated && "error" in updated) {
    return updated;
  }

  return { data: updated };
}

/**
 * Set which ProductMaterial is the active option in an alt group. The target
 * PM must be a member of the group.
 *
 * Errors:
 *   ALT_GROUP_NOT_FOUND     - group doesn't exist
 *   NOT_IN_GROUP            - the ProductMaterial is not a member of this group
 */
export async function setAltGroupActive(altGroupId: string, productMaterialId: string) {
  const group = await prisma.productMaterialAltGroup.findUnique({
    where: { id: altGroupId },
    select: { id: true },
  });

  if (!group) {
    return { error: "Alternate group not found", code: "ALT_GROUP_NOT_FOUND" };
  }

  const pm = await prisma.productMaterial.findUnique({
    where: { id: productMaterialId },
    select: { id: true, altGroupId: true },
  });

  if (!pm || pm.altGroupId !== altGroupId) {
    return { error: "Product material is not a member of this group", code: "NOT_IN_GROUP" };
  }

  const updated = await prisma.productMaterialAltGroup.update({
    where: { id: altGroupId },
    data: { activeProductMaterialId: productMaterialId },
    include: altGroupInclude,
  });

  return { data: updated };
}

/**
 * Remove a ProductMaterial from its alt group (detach to standalone).
 *
 * Rules:
 *   - If the removed PM is NOT the group's active, remove directly.
 *   - If it IS active and the group has other members, the caller must pass
 *     `replaceActiveWithProductMaterialId` pointing to another member — that
 *     member is promoted to active, then the original is detached (atomic).
 *     Without a replacement, returns `NEEDS_ACTIVE_SWAP` so the UI can prompt.
 *   - If it IS active and the only member, the group is deleted entirely —
 *     no swap needed, no dangling empty group.
 *
 * Errors:
 *   PRODUCT_MATERIAL_NOT_FOUND - productMaterialId doesn't exist
 *   NOT_IN_GROUP               - PM isn't in any alt group
 *   NEEDS_ACTIVE_SWAP          - removing the active from a multi-member group without a replacement
 *   REPLACEMENT_NOT_IN_GROUP   - replacement PM isn't a member of the same group
 *   REPLACEMENT_IS_SELF        - replacement and target are the same PM
 */
export async function removeFromAltGroup(productMaterialId: string, replaceActiveWithProductMaterialId?: string) {
  const pm = await prisma.productMaterial.findUnique({
    where: { id: productMaterialId },
    select: {
      id: true,
      altGroupId: true,
      activeOfAltGroup: { select: { id: true } },
    },
  });

  if (!pm) {
    return { error: "Product material not found", code: "PRODUCT_MATERIAL_NOT_FOUND" };
  }
  if (!pm.altGroupId) {
    return { error: "Product material is not in an alternate group", code: "NOT_IN_GROUP" };
  }

  const altGroupId = pm.altGroupId;
  const isActive = !!pm.activeOfAltGroup;

  // Peer count excluding the PM being removed
  const peerCount = await prisma.productMaterial.count({
    where: { altGroupId, id: { not: pm.id } },
  });

  // Validate replacement (if supplied) up front so errors surface cleanly.
  if (replaceActiveWithProductMaterialId) {
    if (replaceActiveWithProductMaterialId === pm.id) {
      return {
        error: "Replacement cannot be the material being removed",
        code: "REPLACEMENT_IS_SELF",
      };
    }
    const replacement = await prisma.productMaterial.findUnique({
      where: { id: replaceActiveWithProductMaterialId },
      select: { id: true, altGroupId: true },
    });
    if (!replacement || replacement.altGroupId !== altGroupId) {
      return {
        error: "Replacement product material is not a member of this group",
        code: "REPLACEMENT_NOT_IN_GROUP",
      };
    }
  } else if (isActive && peerCount > 0) {
    return {
      error: "This is the active material in a multi-member group — choose another to make active first",
      code: "NEEDS_ACTIVE_SWAP",
    };
  }

  await prisma.$transaction(async (tx) => {
    if (isActive) {
      if (peerCount === 0) {
        // Last member being removed — clear pointer so we can delete the row.
        await tx.productMaterialAltGroup.update({
          where: { id: altGroupId },
          data: { activeProductMaterialId: null },
        });
      } else {
        // Promote replacement to active before detaching this one.
        await tx.productMaterialAltGroup.update({
          where: { id: altGroupId },
          // biome-ignore lint/style/noNonNullAssertion: NEEDS_ACTIVE_SWAP returned earlier if replaceActiveWithProductMaterialId is missing when isActive && peerCount > 0
          data: { activeProductMaterialId: replaceActiveWithProductMaterialId! },
        });
      }
    }
    await tx.productMaterial.update({
      where: { id: pm.id },
      data: { altGroupId: null },
    });
    if (peerCount === 0) {
      await tx.productMaterialAltGroup.delete({ where: { id: altGroupId } });
    }
  });

  return {
    data: {
      productMaterialId,
      altGroupId,
      groupDeleted: peerCount === 0,
      // biome-ignore lint/style/noNonNullAssertion: NEEDS_ACTIVE_SWAP returned earlier if replaceActiveWithProductMaterialId is missing when isActive && peerCount > 0
      newActiveProductMaterialId: isActive && peerCount > 0 ? replaceActiveWithProductMaterialId! : null,
    },
  };
}

/**
 * Rename (or clear) an alt group's label. Passing `null` or an empty string
 * clears the label back to unnamed.
 *
 * Errors:
 *   ALT_GROUP_NOT_FOUND - group doesn't exist
 *   LABEL_CONFLICT      - another group on the same product already has this label
 */
export async function updateAltGroupLabel(altGroupId: string, label: string | null) {
  const group = await prisma.productMaterialAltGroup.findUnique({
    where: { id: altGroupId },
    select: { id: true, productId: true, label: true },
  });

  if (!group) {
    return { error: "Alternate group not found", code: "ALT_GROUP_NOT_FOUND" };
  }

  const trimmed = label?.trim();
  const nextLabel = trimmed ? trimmed : null;

  if (nextLabel === group.label) {
    return {
      data: await prisma.productMaterialAltGroup.findUnique({
        where: { id: altGroupId },
        include: altGroupInclude,
      }),
    };
  }

  if (nextLabel) {
    const collision = await prisma.productMaterialAltGroup.findFirst({
      where: { productId: group.productId, label: nextLabel, id: { not: altGroupId } },
      select: { id: true },
    });
    if (collision) {
      return { error: "Another alternate group on this product already uses that name", code: "LABEL_CONFLICT" };
    }
  }

  const updated = await prisma.productMaterialAltGroup.update({
    where: { id: altGroupId },
    data: { label: nextLabel },
    include: altGroupInclude,
  });

  return { data: updated };
}

/**
 * Delete an alt group: detaches all members to standalone, then removes the
 * group row. Safe no-op if the group doesn't exist.
 */
export async function deleteAltGroup(altGroupId: string) {
  const group = await prisma.productMaterialAltGroup.findUnique({
    where: { id: altGroupId },
    select: { id: true },
  });

  if (!group) {
    return { error: "Alternate group not found", code: "ALT_GROUP_NOT_FOUND" };
  }

  await prisma.$transaction(async (tx) => {
    await tx.productMaterialAltGroup.update({
      where: { id: altGroupId },
      data: { activeProductMaterialId: null },
    });
    await tx.productMaterial.updateMany({
      where: { altGroupId },
      data: { altGroupId: null },
    });
    await tx.productMaterialAltGroup.delete({ where: { id: altGroupId } });
  });

  return { data: { altGroupId } };
}

// ============================================================================
// Picture Operations
// ============================================================================

/**
 * Add a picture to a product
 * Returns the picture record and a presigned upload URL
 */
export async function addPicture(input: AddPictureInput) {
  const { productId, filename, contentType, size } = input;

  // Validate storage is enabled
  if (!storage.isStorageEnabled()) {
    return { error: "Storage is not configured", code: "STORAGE_NOT_CONFIGURED" };
  }

  // Validate upload parameters
  const validationError = storage.validateUpload(contentType, size);
  if (validationError) {
    return { error: validationError, code: "INVALID_UPLOAD" };
  }

  // Verify product exists and is not deleted
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, deletedAt: true, _count: { select: { pictures: true } } },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  if (product.deletedAt) {
    return { error: "Product has been deleted", code: "PRODUCT_DELETED" };
  }

  // Check picture limit
  if (product._count.pictures >= storage.getMaxPicturesPerProduct()) {
    return {
      error: `Maximum of ${storage.getMaxPicturesPerProduct()} pictures per product`,
      code: "MAX_PICTURES_REACHED",
    };
  }

  // Generate S3 key
  const key = storage.generateProductPictureKey(productId, filename);

  // Create picture record (set as primary if first picture)
  const isFirst = product._count.pictures === 0;
  const picture = await prisma.productPicture.create({
    data: {
      productId,
      key,
      filename,
      contentType,
      size,
      isPrimary: isFirst,
    },
  });

  // Generate presigned upload URL
  const uploadUrl = await storage.getPresignedUploadUrl(key, contentType, size);

  return {
    data: {
      picture,
      uploadUrl,
    },
  };
}

/**
 * Remove a picture from a product (deletes from DB and S3)
 */
export async function removePicture(productId: string, pictureId: string) {
  // Find the picture
  const picture = await prisma.productPicture.findUnique({
    where: { id: pictureId },
  });

  if (!picture) {
    return { error: "Picture not found", code: "PICTURE_NOT_FOUND" };
  }

  if (picture.productId !== productId) {
    return { error: "Picture does not belong to this product", code: "PICTURE_MISMATCH" };
  }

  // Check if this picture's S3 key is shared with other products (from duplicate)
  const sharedCount = await prisma.productPicture.count({
    where: { key: picture.key },
  });

  // Delete from database
  await prisma.productPicture.delete({
    where: { id: pictureId },
  });

  // Only delete from S3 if this is the last reference to this key
  if (sharedCount === 1 && storage.isStorageEnabled()) {
    try {
      await storage.deleteObject(picture.key);
    } catch {
      // Log error but don't fail - DB record is already deleted
    }
  }

  // If this was the primary picture, set another one as primary
  if (picture.isPrimary) {
    const nextPicture = await prisma.productPicture.findFirst({
      where: { productId },
      orderBy: { createdAt: "asc" },
    });
    if (nextPicture) {
      await prisma.productPicture.update({
        where: { id: nextPicture.id },
        data: { isPrimary: true },
      });
    }
  }

  return { success: true };
}

/**
 * Set a picture as the primary picture for a product
 */
export async function setPrimaryPicture(productId: string, pictureId: string) {
  // Find the picture
  const picture = await prisma.productPicture.findUnique({
    where: { id: pictureId },
  });

  if (!picture) {
    return { error: "Picture not found", code: "PICTURE_NOT_FOUND" };
  }

  if (picture.productId !== productId) {
    return { error: "Picture does not belong to this product", code: "PICTURE_MISMATCH" };
  }

  if (picture.isPrimary) {
    return { error: "Picture is already the primary", code: "ALREADY_PRIMARY" };
  }

  // Update in transaction: unset current primary, set new primary
  await prisma.$transaction([
    prisma.productPicture.updateMany({
      where: { productId, isPrimary: true },
      data: { isPrimary: false },
    }),
    prisma.productPicture.update({
      where: { id: pictureId },
      data: { isPrimary: true },
    }),
  ]);

  return { success: true };
}

/**
 * List pictures for a product with presigned download URLs
 */
export async function listPictures(productId: string) {
  // Verify product exists
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: { id: true, deletedAt: true },
  });

  if (!product) {
    return { error: "Product not found", code: "PRODUCT_NOT_FOUND" };
  }

  const pictures = await prisma.productPicture.findMany({
    where: { productId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

  // Generate presigned URLs for all pictures
  const picturesWithUrls = await Promise.all(
    pictures.map(async (pic) => {
      let url: string | null = null;
      if (storage.isStorageEnabled()) {
        try {
          url = await storage.getPresignedDownloadUrl(pic.key);
        } catch {
          // Continue without URL on error
        }
      }
      return { ...pic, url };
    }),
  );

  return { data: picturesWithUrls };
}
