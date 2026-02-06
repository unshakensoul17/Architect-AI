import { memo, useCallback, useMemo } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    type Node,
    type Edge,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import FileNode from './FileNode';
import SymbolNode from './SymbolNode';
import type { GraphData } from '../types';
import { calculateCouplingMetrics } from '../utils/metrics';
import { applyHierarchicalLayout } from '../utils/layout';
import { optimizeEdges } from '../utils/performance';

interface GraphCanvasProps {
    graphData: GraphData | null;
    onNodeClick?: (nodeId: string) => void;
}

const nodeTypes: NodeTypes = {
    fileNode: FileNode,
    symbolNode: SymbolNode,
};

const GraphCanvas = memo(({ graphData, onNodeClick }: GraphCanvasProps) => {
    // Transform graph data to React Flow format
    const { initialNodes, initialEdges } = useMemo(() => {
        if (!graphData) {
            return { initialNodes: [], initialEdges: [] };
        }

        // Calculate coupling metrics
        const metrics = calculateCouplingMetrics(graphData);

        // Group symbols by file
        const symbolsByFile = new Map<string, typeof graphData.symbols>();
        graphData.symbols.forEach((symbol) => {
            if (!symbolsByFile.has(symbol.filePath)) {
                symbolsByFile.set(symbol.filePath, []);
            }
            symbolsByFile.get(symbol.filePath)!.push(symbol);
        });

        // Create file nodes (parent nodes)
        const fileNodes: Node[] = Array.from(symbolsByFile.entries()).map(
            ([filePath, symbols]) => {
                // Calculate average coupling for this file
                const fileCouplings = symbols
                    .map((s) => {
                        const key = `${s.filePath}:${s.name}:${s.range.startLine}`;
                        return metrics.get(key)?.normalizedScore || 0;
                    })
                    .filter((score) => score > 0);

                const avgCoupling =
                    fileCouplings.length > 0
                        ? fileCouplings.reduce((a, b) => a + b, 0) / fileCouplings.length
                        : 0;

                return {
                    id: filePath,
                    type: 'fileNode',
                    position: { x: 0, y: 0 }, // Will be set by layout
                    data: {
                        label: filePath.split('/').pop() || filePath,
                        filePath,
                        symbolCount: symbols.length,
                        avgCoupling,
                        collapsed: false,
                    },
                };
            }
        );

        // Create symbol nodes (child nodes)
        const symbolNodes: Node[] = graphData.symbols.map((symbol) => {
            const key = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
            const coupling = metrics.get(key) || {
                nodeId: key,
                inDegree: 0,
                outDegree: 0,
                cbo: 0,
                normalizedScore: 0,
                color: '#3b82f6',
            };

            return {
                id: key,
                type: 'symbolNode',
                position: { x: 0, y: 0 }, // Will be set by layout
                data: {
                    label: symbol.name,
                    symbolType: symbol.type,
                    complexity: symbol.complexity,
                    coupling,
                    filePath: symbol.filePath,
                    line: symbol.range.startLine,
                },
                parentId: symbol.filePath,
            };
        });

        // Create edges
        const edges: Edge[] = graphData.edges.map((edge, index) => ({
            id: `edge-${index}`,
            source: edge.source,
            target: edge.target,
            type: 'smoothstep',
            animated: edge.type === 'call',
            style: {
                stroke:
                    edge.type === 'call'
                        ? '#3b82f6'
                        : edge.type === 'import'
                            ? '#10b981'
                            : '#6b7280',
                strokeWidth: 1.5,
            },
        }));

        // Optimize edges for performance
        const optimizedEdges = optimizeEdges(edges, 1000);

        // Apply layout
        const { nodes: layoutedNodes, edges: layoutedEdges } =
            applyHierarchicalLayout([...fileNodes, ...symbolNodes], optimizedEdges);

        return {
            initialNodes: layoutedNodes,
            initialEdges: layoutedEdges,
        };
    }, [graphData]);

    const [nodes, , onNodesChange] = useNodesState(initialNodes);
    const [edges, , onEdgesChange] = useEdgesState(initialEdges);

    const handleNodeClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (onNodeClick) {
                onNodeClick(node.id);
            }
        },
        [onNodeClick]
    );

    if (!graphData) {
        return (
            <div className="flex items-center justify-center w-full h-full">
                <div className="text-center">
                    <div className="text-lg font-semibold mb-2">No Graph Data</div>
                    <div className="text-sm opacity-70">
                        Index your workspace to visualize the code graph
                    </div>
                </div>
            </div>
        );
    }

    return (
        <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onNodeClick={handleNodeClick}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.1}
            maxZoom={2}
            defaultEdgeOptions={{
                type: 'smoothstep',
            }}
        >
            <Background />
            <Controls />
            <MiniMap
                nodeColor={(node) => {
                    if (node.type === 'fileNode') {
                        return '#3b82f6';
                    }
                    return (node.data as any).coupling?.color || '#6b7280';
                }}
                maskColor="rgba(0, 0, 0, 0.5)"
            />
        </ReactFlow>
    );
});

GraphCanvas.displayName = 'GraphCanvas';

export default GraphCanvas;
