import prisma from "@rw/db";

export async function setDefault(workspaceId: string) {
  // Unset any existing default
  await prisma.workspace.updateMany({
    where: { isDefault: true },
    data: { isDefault: false },
  });

  // Set new default
  return prisma.workspace.update({
    where: { id: workspaceId },
    data: { isDefault: true },
  });
}

export async function getDefault() {
  return prisma.workspace.findFirst({
    where: { isDefault: true },
  });
}

export async function clearDefault() {
  await prisma.workspace.updateMany({
    where: { isDefault: true },
    data: { isDefault: false },
  });
}

export async function assignToDefault(userId: string) {
  const defaultWorkspace = await getDefault();

  if (!defaultWorkspace) {
    return null;
  }

  // Check if already a member
  const existingMembership = await prisma.workspaceMembership.findUnique({
    where: {
      userId_workspaceId: {
        userId,
        workspaceId: defaultWorkspace.id,
      },
    },
  });

  if (existingMembership) {
    return existingMembership;
  }

  return null;
}

export async function ensureDefaultExists() {
  const defaultWorkspace = await getDefault();

  if (defaultWorkspace) {
    return defaultWorkspace;
  }

  // Create a default workspace if none exists. Default role rows are seeded by
  // seed scripts, not by runtime workspace provisioning.
  return prisma.workspace.create({
    data: {
      name: "Default",
      slug: "default",
      description: "Default workspace",
      isDefault: true,
    },
  });
}
