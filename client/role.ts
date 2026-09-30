import type { Role } from "../shared/contracts";

/** Lets the settings screen switch the header buttons over without a reload. */
const listeners = new Set<(role: Role) => void>();

export function onRoleChange(listener: (role: Role) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function announceRole(role: Role) {
  for (const listener of listeners) listener(role);
}
