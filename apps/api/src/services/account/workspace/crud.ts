import prisma from "@rw/db";

export interface CreateWorkspaceInput {
  name: string;
  slug?: string;
  description?: string;
  isDefault?: boolean;
  settings?: Record<string, unknown>;
}

export interface UpdateWorkspaceInput {
  name?: string;
  slug?: string;
  description?: string;
  settings?: Record<string, unknown>;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function exposeMemberCount<T extends { _count: { memberships: number } }>(workspace: T) {
  return {
    ...workspace,
    _count: { members: workspace._count.memberships },
  };
}

export async function create(input: CreateWorkspaceInput) {
  const { name, slug, description, isDefault, settings } = input;

  const finalSlug = slug || slugify(name);

  // If this is set as default, unset any existing default
  if (isDefault) {
    await prisma.workspace.updateMany({
      where: { isDefault: true },
      data: { isDefault: false },
    });
  }

  return prisma.workspace.create({
    data: {
      name,
      slug: finalSlug,
      description,
      isDefault: isDefault || false,
      settings: (settings ?? {}) as any,
    },
  });
}

export async function list() {
  const workspaces = await prisma.workspace.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: {
        select: { memberships: true },
      },
    },
  });
  return workspaces.map(exposeMemberCount);
}

export async function getById(id: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    include: {
      _count: {
        select: { memberships: true },
      },
    },
  });
  return workspace ? exposeMemberCount(workspace) : null;
}

export async function getBySlug(slug: string) {
  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    include: {
      _count: {
        select: { memberships: true },
      },
    },
  });
  return workspace ? exposeMemberCount(workspace) : null;
}

export async function update(id: string, input: UpdateWorkspaceInput) {
  const { name, slug, description, settings } = input;

  const updateData: Record<string, unknown> = {};
  if (name !== undefined) updateData.name = name;
  if (slug !== undefined) updateData.slug = slug;
  if (description !== undefined) updateData.description = description;
  if (settings !== undefined) updateData.settings = settings;

  return prisma.workspace.update({
    where: { id },
    data: updateData,
  });
}

export async function remove(id: string) {
  await prisma.workspace.delete({ where: { id } });
}

export async function exists(id: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { id },
    select: { id: true },
  });
  return !!workspace;
}

export async function slugExists(slug: string): Promise<boolean> {
  const workspace = await prisma.workspace.findUnique({
    where: { slug },
    select: { id: true },
  });
  return !!workspace;
}
