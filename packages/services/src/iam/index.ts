// IAM — role-based access control for the User principal tier.
//
// Permissions are `resource:action` strings defined in code (permissions.ts).
// Roles are DB rows owned by a Workspace, carrying an array of those strings.
// A RoleAssignment links a WorkspaceMembership to a Role, optionally narrowed
// to one Site.
//
// See /Users/michaellindenau/.claude/plans/user-invites-are-not-parallel-abelson.md
// for the full RFC.

export * as roles from "./roles.js";
export * as assignments from "./assignments.js";

export {
  RESOURCES,
  ACTIONS,
  ALL_PERMISSIONS,
  OWNER_PERMISSION,
  RESERVED_PERMISSIONS,
  SYSTEM_ROLE_PERMISSIONS,
  hasOwnerPermission,
  isPermission,
  validatePermissions,
  getEffectivePermissions,
  hasPermission,
  hasAnyPermission,
  getAccessibleSites,
  listAccessibleSites,
  type Resource,
  type Action,
  type ReservedPermission,
  type Permission,
  type PermissionContext,
  type AccessibleSites,
  type AccessibleSiteRef,
} from "./permissions.js";

export { findSystemRole } from "./roles.js";

export { ScopeMismatchError, SystemUserAssignmentError } from "./assignments.js";
