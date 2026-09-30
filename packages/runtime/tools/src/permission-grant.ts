import type { ToolPermissionGrant } from "./types.js";

const issuedGrants = new WeakSet<object>();

export interface CreateToolPermissionGrantInput {
  readonly projectId: string;
  readonly runId: string;
  readonly permissions: readonly string[];
}

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
  return normalized;
}

export function createToolPermissionGrant(
  input: CreateToolPermissionGrantInput,
): ToolPermissionGrant {
  const permissions = Object.freeze(
    [...new Set(input.permissions.map((permission) => requireNonEmpty(permission, "permission")))].sort(),
  );
  const grant = Object.freeze({
    projectId: requireNonEmpty(input.projectId, "projectId"),
    runId: requireNonEmpty(input.runId, "runId"),
    permissions,
  });
  issuedGrants.add(grant);
  return grant as ToolPermissionGrant;
}

export function isIssuedPermissionGrant(
  value: ToolPermissionGrant,
): boolean {
  return issuedGrants.has(value);
}
