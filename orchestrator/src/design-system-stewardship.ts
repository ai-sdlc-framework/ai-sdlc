/**
 * Stewardship enforcement for DesignSystemBinding resources (RFC-0006 §5.3).
 *
 * Validates that changes to authority-scoped fields are submitted by
 * authorized principals. Changes to sharedAuthority fields require
 * approval from both disciplines when requireBothDisciplines is true.
 */

import type { DesignSystemBinding, Stewardship } from '@ai-sdlc/reference';

export interface StewardshipDecision {
  allowed: boolean;
  reason: string;
  requiredApprovals?: string[];
}

/**
 * Determine which authority scope a field belongs to.
 */
function findAuthorityScope(
  stewardship: Stewardship,
  field: string,
): 'design' | 'engineering' | 'shared' | 'none' {
  if (stewardship.sharedAuthority?.scope?.includes(field)) return 'shared';
  if (stewardship.designAuthority.scope.includes(field)) return 'design';
  if (stewardship.engineeringAuthority.scope.includes(field)) return 'engineering';
  return 'none';
}

/**
 * Check if a principal is authorized for a given authority scope.
 */
function isAuthorized(stewardship: Stewardship, principal: string, scope: string): boolean {
  const authorityType = findAuthorityScope(stewardship, scope);

  switch (authorityType) {
    case 'design':
      return stewardship.designAuthority.principals.includes(principal);
    case 'engineering':
      return stewardship.engineeringAuthority.principals.includes(principal);
    case 'shared':
      return (
        stewardship.designAuthority.principals.includes(principal) ||
        stewardship.engineeringAuthority.principals.includes(principal) ||
        (stewardship.sharedAuthority?.principals?.includes(principal) ?? false)
      );
    case 'none':
      return true; // Unscoped fields are unrestricted
  }
}

/**
 * Enforce stewardship constraints on a proposed change to a DesignSystemBinding.
 *
 * @param changedFields - The field paths being modified
 * @param principal - The identity of the person/agent making the change
 * @param binding - The DesignSystemBinding being modified
 */
export function enforceStewardship(
  changedFields: string[],
  principal: string,
  binding: DesignSystemBinding,
): StewardshipDecision {
  const stewardship = binding.spec.stewardship;
  const requireBoth = stewardship.changeApproval?.requireBothDisciplines ?? true;

  for (const field of changedFields) {
    const scope = findAuthorityScope(stewardship, field);

    // Shared authority fields may require both disciplines
    if (scope === 'shared' && requireBoth) {
      const isDesign = stewardship.designAuthority.principals.includes(principal);
      const isEngineering = stewardship.engineeringAuthority.principals.includes(principal);
      const isShared = stewardship.sharedAuthority?.principals?.includes(principal) ?? false;

      if (!isDesign && !isEngineering && !isShared) {
        return {
          allowed: false,
          reason: `Principal "${principal}" is not authorized for shared-authority field "${field}"`,
        };
      }

      // Identify which discipline still needs to approve
      const needed: string[] = [];
      if (!isDesign && !isShared) needed.push('design');
      if (!isEngineering && !isShared) needed.push('engineering');

      if (needed.length > 0) {
        return {
          allowed: false,
          reason: `Shared-authority field "${field}" requires approval from both disciplines. Pending: ${needed.join(', ')}`,
          requiredApprovals: needed,
        };
      }
    }

    // Design/engineering scoped fields
    if (!isAuthorized(stewardship, principal, field)) {
      return {
        allowed: false,
        reason: `Principal "${principal}" is not authorized for ${scope}-authority field "${field}"`,
      };
    }
  }

  return { allowed: true, reason: 'All changed fields are within principal authority' };
}
