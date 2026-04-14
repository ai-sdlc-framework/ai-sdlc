/**
 * Validates DesignSystemBinding inheritance constraints (RFC-0006 §5.6).
 *
 * Multi-brand inheritance uses the `extends` field. Validation enforces:
 * - Child compliance thresholds >= parent thresholds
 * - Child cannot remove parent disallowHardcoded categories
 * - Inheritance depth limited to two levels (parent → child)
 */

import type { DesignSystemBinding } from '@ai-sdlc/reference';

export interface InheritanceError {
  field: string;
  message: string;
}

export interface InheritanceValidationResult {
  valid: boolean;
  errors: InheritanceError[];
}

/**
 * Resolve the parent binding from the collection by name.
 */
export function resolveParent(
  child: DesignSystemBinding,
  bindings: DesignSystemBinding[],
): DesignSystemBinding | undefined {
  if (!child.spec.extends) return undefined;
  return bindings.find((b) => b.metadata.name === child.spec.extends);
}

/**
 * Validate that a child DesignSystemBinding conforms to its parent's constraints.
 *
 * Rules:
 * 1. Child compliance.coverage.minimum >= parent compliance.coverage.minimum
 * 2. Child compliance.coverage.target >= parent compliance.coverage.target (if both defined)
 * 3. Child must not remove any parent disallowHardcoded categories
 * 4. Two-level depth limit: parent must not itself have an `extends` field
 */
export function validateDesignSystemInheritance(
  child: DesignSystemBinding,
  parent: DesignSystemBinding,
): InheritanceValidationResult {
  const errors: InheritanceError[] = [];

  // Depth limit: parent must not extend another binding
  if (parent.spec.extends) {
    errors.push({
      field: 'extends',
      message: `Inheritance depth exceeds two levels: "${child.metadata.name}" extends "${parent.metadata.name}" which extends "${parent.spec.extends}". Only parent → child is supported in v1alpha1.`,
    });
  }

  // Coverage minimum: child >= parent
  const parentMin = parent.spec.compliance.coverage.minimum;
  const childMin = child.spec.compliance.coverage.minimum;
  if (childMin < parentMin) {
    errors.push({
      field: 'compliance.coverage.minimum',
      message: `Child minimum coverage (${childMin}) is less than parent minimum (${parentMin}). Child thresholds can only tighten, not loosen.`,
    });
  }

  // Coverage target: child >= parent (if both defined)
  const parentTarget = parent.spec.compliance.coverage.target;
  const childTarget = child.spec.compliance.coverage.target;
  if (parentTarget !== undefined && childTarget !== undefined && childTarget < parentTarget) {
    errors.push({
      field: 'compliance.coverage.target',
      message: `Child target coverage (${childTarget}) is less than parent target (${parentTarget}). Child thresholds can only tighten, not loosen.`,
    });
  }

  // disallowHardcoded: child must not remove parent categories
  const parentCategories = new Set(
    (parent.spec.compliance.disallowHardcoded ?? []).map((r) => r.category),
  );
  const childCategories = new Set(
    (child.spec.compliance.disallowHardcoded ?? []).map((r) => r.category),
  );

  for (const category of parentCategories) {
    if (!childCategories.has(category)) {
      errors.push({
        field: 'compliance.disallowHardcoded',
        message: `Child removes parent disallowHardcoded category "${category}". Child bindings may add categories but must not remove parent categories.`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate all DesignSystemBinding inheritance relationships in a collection.
 * Returns errors for any invalid inheritance chains.
 */
export function validateAllInheritance(
  bindings: DesignSystemBinding[],
): InheritanceValidationResult {
  const allErrors: InheritanceError[] = [];

  for (const binding of bindings) {
    if (!binding.spec.extends) continue;

    const parent = resolveParent(binding, bindings);
    if (!parent) {
      allErrors.push({
        field: 'extends',
        message: `Binding "${binding.metadata.name}" extends "${binding.spec.extends}" but no binding with that name exists.`,
      });
      continue;
    }

    const result = validateDesignSystemInheritance(binding, parent);
    allErrors.push(...result.errors);
  }

  return { valid: allErrors.length === 0, errors: allErrors };
}
