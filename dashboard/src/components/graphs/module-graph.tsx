/**
 * Simple module dependency graph rendered as SVG with force-directed layout.
 * Uses a basic spring-force simulation for positioning.
 */

export interface GraphNode {
  id: string;
  label: string;
  group?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
}

interface ModuleGraphProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  width?: number;
  height?: number;
}

function layoutNodes(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();

  // Initialize in a circle
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width, height) * 0.35;

  nodes.forEach((node, i) => {
    const angle = (2 * Math.PI * i) / nodes.length;
    positions.set(node.id, {
      x: cx + radius * Math.cos(angle),
      y: cy + radius * Math.sin(angle),
    });
  });

  // Simple force iteration (spring model)
  const edgeSet = new Set(edges.map((e) => `${e.source}:${e.target}`));
  for (let iter = 0; iter < 50; iter++) {
    for (const a of nodes) {
      const posA = positions.get(a.id)!;
      let fx = 0;
      let fy = 0;

      for (const b of nodes) {
        if (a.id === b.id) continue;
        const posB = positions.get(b.id)!;
        const dx = posA.x - posB.x;
        const dy = posA.y - posB.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);

        // Repulsion
        const repulsion = 2000 / (dist * dist);
        fx += (dx / dist) * repulsion;
        fy += (dy / dist) * repulsion;

        // Attraction for connected nodes
        if (edgeSet.has(`${a.id}:${b.id}`) || edgeSet.has(`${b.id}:${a.id}`)) {
          const attraction = dist * 0.01;
          fx -= (dx / dist) * attraction;
          fy -= (dy / dist) * attraction;
        }
      }

      // Center gravity
      fx -= (posA.x - cx) * 0.005;
      fy -= (posA.y - cy) * 0.005;

      posA.x = Math.max(30, Math.min(width - 30, posA.x + fx * 0.1));
      posA.y = Math.max(30, Math.min(height - 30, posA.y + fy * 0.1));
    }
  }

  return positions;
}

const groupColors: Record<string, string> = {
  core: '#3b82f6',
  util: '#8b5cf6',
  api: '#06b6d4',
  test: '#f59e0b',
  default: '#64748b',
};

export function ModuleGraph({ nodes, edges, width = 600, height = 400 }: ModuleGraphProps) {
  if (nodes.length === 0) return <svg width={width} height={height} />;

  const positions = layoutNodes(nodes, edges, width, height);

  return (
    <svg width={width} height={height} role="img" aria-label="Module dependency graph">
      {/* Edges */}
      {edges.map((edge) => {
        const from = positions.get(edge.source);
        const to = positions.get(edge.target);
        if (!from || !to) return null;
        return (
          <line
            key={`${edge.source}-${edge.target}`}
            x1={from.x}
            y1={from.y}
            x2={to.x}
            y2={to.y}
            stroke="#cbd5e1"
            strokeWidth={1}
            markerEnd="url(#arrowhead)"
          />
        );
      })}

      {/* Arrow marker */}
      <defs>
        <marker id="arrowhead" markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
          <polygon points="0 0, 8 3, 0 6" fill="#cbd5e1" />
        </marker>
      </defs>

      {/* Nodes */}
      {nodes.map((node) => {
        const pos = positions.get(node.id);
        if (!pos) return null;
        const color = groupColors[node.group ?? 'default'] ?? groupColors.default;
        return (
          <g key={node.id}>
            <circle cx={pos.x} cy={pos.y} r={16} fill={color} opacity={0.8} />
            <text x={pos.x} y={pos.y + 28} textAnchor="middle" fontSize={10} fill="#334155">
              {node.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
