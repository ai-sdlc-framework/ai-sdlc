import { describe, it, expect } from 'vitest';
import { ModuleGraph, type GraphNode, type GraphEdge } from './module-graph';

describe('ModuleGraph', () => {
  it('renders empty SVG for no nodes', () => {
    const result = ModuleGraph({ nodes: [], edges: [] });
    expect(result).toBeTruthy();
  });

  it('renders nodes and edges', () => {
    const nodes: GraphNode[] = [
      { id: 'core', label: 'core', group: 'core' },
      { id: 'api', label: 'api', group: 'api' },
      { id: 'utils', label: 'utils', group: 'util' },
    ];
    const edges: GraphEdge[] = [
      { source: 'api', target: 'core' },
      { source: 'api', target: 'utils' },
    ];
    const result = ModuleGraph({ nodes, edges });
    expect(result).toBeTruthy();
    expect(result?.props?.width).toBe(600);
  });

  it('handles disconnected nodes', () => {
    const nodes: GraphNode[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B' },
    ];
    const result = ModuleGraph({ nodes, edges: [] });
    expect(result).toBeTruthy();
  });

  it('handles single node', () => {
    const nodes: GraphNode[] = [{ id: 'solo', label: 'Solo' }];
    const result = ModuleGraph({ nodes, edges: [] });
    expect(result).toBeTruthy();
  });

  it('accepts custom dimensions', () => {
    const nodes: GraphNode[] = [{ id: 'a', label: 'A' }];
    const result = ModuleGraph({ nodes, edges: [], width: 800, height: 500 });
    expect(result?.props?.width).toBe(800);
    expect(result?.props?.height).toBe(500);
  });

  it('ignores edges to missing nodes', () => {
    const nodes: GraphNode[] = [{ id: 'a', label: 'A' }];
    const edges: GraphEdge[] = [{ source: 'a', target: 'missing' }];
    const result = ModuleGraph({ nodes, edges });
    expect(result).toBeTruthy();
  });
});
