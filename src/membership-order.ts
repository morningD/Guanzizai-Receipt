import type { MembershipProfile } from "./user-profile";

export function orderMemberships(memberships: MembershipProfile[]) {
  const ordered: MembershipProfile[] = [];
  const visited = new Set<string>();
  const appendBranch = (membership: MembershipProfile) => {
    if (visited.has(membership.id)) return;
    visited.add(membership.id);
    ordered.push(membership);
    memberships.filter((candidate) => candidate.parentId === membership.id).forEach(appendBranch);
  };

  memberships.filter((membership) => !membership.parentId).forEach(appendBranch);
  memberships.forEach(appendBranch);
  return ordered;
}
