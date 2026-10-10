/**
 * Declaration and call-site extraction from a tree-sitter syntax tree.
 *
 * Callers and callees are matched by NAME, not by type: a call `x.save()` is recorded
 * as a call to `save`, whichever `save` it resolves to. That over-reports callers,
 * which raises a hunk's risk rank and is the safe direction.
 *
 * The walk is iterative, so a deeply nested file cannot overflow the stack.
 *
 * @module review-risk-map/tree-sitter-extract
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageFamily } from './tree-sitter-languages.js';

export type DeclKind = 'function' | 'method' | 'class' | 'const';

export interface Declaration {
  /** The bare name, which is what callers are matched on. */
  name: string;
  /** `Class.method` for a method, otherwise the bare name. */
  qualified: string;
  kind: DeclKind;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
}

export interface CallSite {
  /** The called name: `x.save()` is `save`. */
  name: string;
  /** 1-based line of the call. */
  line: number;
  /** The qualified name of the innermost declaration containing the call, or `<module>`. */
  enclosing: string;
}

export interface FileFacts {
  declarations: Declaration[];
  calls: CallSite[];
}

/** Marks a call outside any declaration. */
export const MODULE_SCOPE = '<module>';

const MAX_DECLARATIONS = 5000;
const MAX_CALLS = 20_000;

interface Frame {
  node: SyntaxNode;
  /** Enclosing class name, for qualifying methods. */
  scope: string | undefined;
  /** Qualified name of the innermost enclosing declaration. */
  enclosing: string;
  exported: boolean;
}

const text = (n: SyntaxNode | null): string | undefined => {
  const t = n?.text;
  return t && t.length > 0 && t.length <= 256 ? t : undefined;
};

function childrenOf(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c): c is SyntaxNode => c !== null);
}

function lines(node: SyntaxNode): { startLine: number; endLine: number } {
  return { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
}

const FUNCTION_VALUES = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

interface Visit {
  decl?: Declaration;
  /** Class scope the children are walked in. */
  scope?: string | undefined;
  /** Whether the children inherit the `exported` flag. */
  exported?: boolean;
  call?: string;
}

/** Name of the called function for an ECMAScript or Go call expression's `function` field. */
function calleeName(fn: SyntaxNode | null): string | undefined {
  if (!fn) return undefined;
  switch (fn.type) {
    case 'identifier':
    case 'property_identifier':
      return text(fn);
    case 'member_expression':
      return text(fn.childForFieldName('property'));
    case 'attribute':
      return text(fn.childForFieldName('attribute'));
    case 'selector_expression':
      return text(fn.childForFieldName('field'));
    default:
      return undefined;
  }
}

function visitEcmascript(n: SyntaxNode, f: Frame): Visit {
  switch (n.type) {
    case 'export_statement':
      return { exported: true };
    case 'function_declaration':
    case 'generator_function_declaration': {
      const name = text(n.childForFieldName('name'));
      return name
        ? { decl: { name, qualified: name, kind: 'function', ...lines(n) }, exported: false }
        : {};
    }
    case 'class_declaration':
    case 'abstract_class_declaration': {
      const name = text(n.childForFieldName('name'));
      return name
        ? {
            decl: { name, qualified: name, kind: 'class', ...lines(n) },
            scope: name,
            exported: false,
          }
        : {};
    }
    case 'method_definition':
    case 'method_signature': {
      const name = text(n.childForFieldName('name'));
      return name
        ? {
            decl: {
              name,
              qualified: f.scope ? `${f.scope}.${name}` : name,
              kind: 'method',
              ...lines(n),
            },
            exported: false,
          }
        : {};
    }
    case 'public_field_definition': {
      const name = text(n.childForFieldName('name'));
      const value = n.childForFieldName('value');
      if (name && value && FUNCTION_VALUES.has(value.type)) {
        return {
          decl: {
            name,
            qualified: f.scope ? `${f.scope}.${name}` : name,
            kind: 'method',
            ...lines(n),
          },
          exported: false,
        };
      }
      return {};
    }
    case 'variable_declarator': {
      const idNode = n.childForFieldName('name');
      const name = idNode?.type === 'identifier' ? text(idNode) : undefined;
      if (!name) return {};
      const value = n.childForFieldName('value');
      if (value && FUNCTION_VALUES.has(value.type)) {
        return {
          decl: { name, qualified: name, kind: 'function', ...lines(n) },
          exported: false,
        };
      }
      // A constant is only a declaration worth reporting when it is exported.
      return f.exported
        ? { decl: { name, qualified: name, kind: 'const', ...lines(n) }, exported: false }
        : {};
    }
    case 'call_expression': {
      const call = calleeName(n.childForFieldName('function'));
      return call ? { call } : {};
    }
    case 'new_expression': {
      const call = calleeName(n.childForFieldName('constructor'));
      return call ? { call } : {};
    }
    default:
      return {};
  }
}

function visitPython(n: SyntaxNode, f: Frame): Visit {
  switch (n.type) {
    case 'function_definition': {
      const name = text(n.childForFieldName('name'));
      if (!name) return {};
      const inClass = f.scope !== undefined && f.enclosing === f.scope;
      return {
        decl: {
          name,
          qualified: inClass ? `${f.scope}.${name}` : name,
          kind: inClass ? 'method' : 'function',
          ...lines(n),
        },
        scope: undefined,
      };
    }
    case 'class_definition': {
      const name = text(n.childForFieldName('name'));
      return name
        ? { decl: { name, qualified: name, kind: 'class', ...lines(n) }, scope: name }
        : {};
    }
    case 'assignment': {
      // A module-level assignment to a plain name is a module constant.
      const left = n.childForFieldName('left');
      const name = left?.type === 'identifier' ? text(left) : undefined;
      if (name && n.parent?.parent?.type === 'module') {
        return { decl: { name, qualified: name, kind: 'const', ...lines(n) } };
      }
      return {};
    }
    case 'call': {
      const call = calleeName(n.childForFieldName('function'));
      return call ? { call } : {};
    }
    default:
      return {};
  }
}

function receiverType(n: SyntaxNode): string | undefined {
  const m = /([A-Za-z_]\w*)\s*\)\s*$/.exec(n.childForFieldName('receiver')?.text ?? '');
  return m?.[1];
}

function visitGo(n: SyntaxNode): Visit {
  switch (n.type) {
    case 'function_declaration': {
      const name = text(n.childForFieldName('name'));
      return name ? { decl: { name, qualified: name, kind: 'function', ...lines(n) } } : {};
    }
    case 'method_declaration': {
      const name = text(n.childForFieldName('name'));
      if (!name) return {};
      const recv = receiverType(n);
      return {
        decl: {
          name,
          qualified: recv ? `${recv}.${name}` : name,
          kind: 'method',
          ...lines(n),
        },
      };
    }
    case 'type_spec': {
      const name = text(n.childForFieldName('name'));
      return name ? { decl: { name, qualified: name, kind: 'class', ...lines(n) } } : {};
    }
    case 'const_spec': {
      // Only an exported (capitalised) top-level constant is reported.
      const name = text(n.childForFieldName('name'));
      const topLevel = n.parent?.parent?.type === 'source_file';
      return name && topLevel && /^[A-Z]/.test(name)
        ? { decl: { name, qualified: name, kind: 'const', ...lines(n) } }
        : {};
    }
    case 'call_expression': {
      const call = calleeName(n.childForFieldName('function'));
      return call ? { call } : {};
    }
    default:
      return {};
  }
}

/** Extract declarations and call sites from a parsed file. */
export function extractFileFacts(root: SyntaxNode, family: LanguageFamily): FileFacts {
  const declarations: Declaration[] = [];
  const calls: CallSite[] = [];
  const stack: Frame[] = [
    { node: root, scope: undefined, enclosing: MODULE_SCOPE, exported: false },
  ];

  while (stack.length > 0) {
    const f = stack.pop()!;
    const v =
      family === 'ecmascript'
        ? visitEcmascript(f.node, f)
        : family === 'python'
          ? visitPython(f.node, f)
          : visitGo(f.node);

    let enclosing = f.enclosing;
    if (v.decl && declarations.length < MAX_DECLARATIONS) {
      declarations.push(v.decl);
      enclosing = v.decl.qualified;
    }
    if (v.call && calls.length < MAX_CALLS) {
      calls.push({ name: v.call, line: f.node.startPosition.row + 1, enclosing });
    }
    const scope = 'scope' in v ? v.scope : f.scope;
    const exported = v.exported ?? f.exported;
    // Push in reverse so children are visited in source order.
    const kids = childrenOf(f.node);
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push({
        node: kids[i]!,
        scope,
        enclosing: v.decl ? v.decl.qualified : enclosing,
        exported,
      });
    }
  }
  return { declarations, calls };
}
