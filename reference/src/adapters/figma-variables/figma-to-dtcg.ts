/**
 * Translates Figma Variables API responses to W3C DTCG format.
 */

import type { DesignToken, DesignTokenSet } from '../interfaces.js';

/** Figma variable as returned by the Variables API. */
export interface FigmaVariable {
  id: string;
  name: string;
  key: string;
  resolvedType: 'BOOLEAN' | 'FLOAT' | 'STRING' | 'COLOR';
  valuesByMode: Record<string, FigmaVariableValue>;
  description?: string;
}

/** Figma variable value (differs by type). */
export type FigmaVariableValue =
  | number
  | string
  | boolean
  | { r: number; g: number; b: number; a: number }
  | { type: 'VARIABLE_ALIAS'; id: string };

/** Figma variable collection from the API. */
export interface FigmaVariableCollection {
  id: string;
  name: string;
  modes: Array<{ modeId: string; name: string }>;
  variableIds: string[];
}

/** Full response from GET /v1/files/:key/variables/local. */
export interface FigmaVariablesResponse {
  status: number;
  error: boolean;
  meta: {
    variables: Record<string, FigmaVariable>;
    variableCollections: Record<string, FigmaVariableCollection>;
  };
}

const FIGMA_TYPE_TO_DTCG: Record<string, string> = {
  COLOR: 'color',
  FLOAT: 'number',
  STRING: 'string',
  BOOLEAN: 'boolean',
};

/**
 * Convert a Figma color value {r, g, b, a} to hex string.
 */
function figmaColorToHex(color: { r: number; g: number; b: number; a: number }): string {
  const r = Math.round(color.r * 255);
  const g = Math.round(color.g * 255);
  const b = Math.round(color.b * 255);
  const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
  if (color.a < 1) {
    const a = Math.round(color.a * 255);
    return hex + a.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Convert a Figma variable value to a DTCG $value.
 */
function convertValue(
  value: FigmaVariableValue,
  resolvedType: string,
  variables: Record<string, FigmaVariable>,
): string | number | boolean | Record<string, unknown> {
  // Alias reference
  if (
    typeof value === 'object' &&
    value !== null &&
    'type' in value &&
    value.type === 'VARIABLE_ALIAS'
  ) {
    const aliasedVar = variables[value.id];
    if (aliasedVar) {
      const path = aliasedVar.name.replace(/\//g, '.');
      return `{${path}}`;
    }
    return `{unknown.${value.id}}`;
  }

  // Color
  if (resolvedType === 'COLOR' && typeof value === 'object' && value !== null && 'r' in value) {
    return figmaColorToHex(value as { r: number; g: number; b: number; a: number });
  }

  // Primitive
  return value as string | number | boolean;
}

/**
 * Convert a Figma variable name (slash-separated) into nested DTCG path.
 * e.g., "color/primary/500" → ["color", "primary", "500"]
 */
function nameToParts(name: string): string[] {
  return name.split('/').map((p) => p.trim().replace(/\s+/g, '-').toLowerCase());
}

/**
 * Set a nested value in a DesignTokenSet using a path array.
 */
function setNestedToken(target: DesignTokenSet, parts: string[], token: DesignToken): void {
  let current: DesignTokenSet = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== 'object' || '$type' in current[key]) {
      current[key] = {};
    }
    current = current[key] as DesignTokenSet;
  }
  current[parts[parts.length - 1]] = token;
}

/**
 * Transform a Figma Variables API response into a W3C DTCG DesignTokenSet.
 *
 * Collections map to top-level groups. Modes create separate token groups
 * under each collection. If there's only one mode, tokens are placed directly
 * under the collection group.
 */
export function figmaVariablesToDtcg(
  response: FigmaVariablesResponse,
  options?: { mode?: string },
): DesignTokenSet {
  const { variables, variableCollections } = response.meta;
  const result: DesignTokenSet = {};

  for (const collection of Object.values(variableCollections)) {
    const targetMode = options?.mode
      ? collection.modes.find((m) => m.name === options.mode)
      : collection.modes[0];

    if (!targetMode) continue;

    for (const varId of collection.variableIds) {
      const variable = variables[varId];
      if (!variable) continue;

      const modeValue = variable.valuesByMode[targetMode.modeId];
      if (modeValue === undefined) continue;

      const dtcgType = FIGMA_TYPE_TO_DTCG[variable.resolvedType] ?? 'string';
      const dtcgValue = convertValue(modeValue, variable.resolvedType, variables);

      const parts = nameToParts(variable.name);
      const token: DesignToken = {
        $type: dtcgType,
        $value: dtcgValue,
        ...(variable.description ? { $description: variable.description } : {}),
      };

      setNestedToken(result, parts, token);
    }
  }

  return result;
}
