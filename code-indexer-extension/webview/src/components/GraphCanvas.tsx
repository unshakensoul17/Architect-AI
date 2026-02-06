import { memo, useCallback, useEffect, useState } from 'react';
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
import DomainNode from './DomainNode';
import type { GraphData, DomainNodeData } from '../types';
import { calculateCouplingMetrics } from '../utils/metrics';
import { applyElkLayout } from '../utils/elk-layout';
import { optimizeEdges } from '../utils/performance';

interface GraphCanvasProps {
    graphData: GraphData | null;
    onNodeClick?: (nodeId: string) => void;
}

const nodeTypes: NodeTypes = {
    fileNode: FileNode,
    symbolNode: SymbolNode,
    domainNode: DomainNode,
};

const GraphCanvas = memo(({ graphData, onNodeClick }: GraphCanvasProps) => {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [isLayouting, setIsLayouting] = useState(false);

    useEffect(() => {
        if (!graphData) {
            setNodes([]);
            setEdges([]);
            return;
        }

        const runLayout = async () => {
            setIsLayouting(true);
            try {
                // Calculate coupling metrics
                const metrics = calculateCouplingMetrics(graphData);

                // Create domain nodes (top level)
                const domainNodes: Node[] = graphData.domains.map((domainData) => ({
                    id: `domain:${domainData.domain}`,
                    type: 'domainNode',
                    position: { x: 0, y: 0 },
                    data: {
                        domain: domainData.domain,
                        health: domainData.health,
                        collapsed: false,
                    } as DomainNodeData,
                }));

                // Group symbols by domain and file
                const symbolsByDomain = new Map<string, Map<string, typeof graphData.symbols>>();
                graphData.symbols.forEach((symbol) => {
                    const domain = symbol.domain || 'unknown';
                    if (!symbolsByDomain.has(domain)) {
                        symbolsByDomain.set(domain, new Map());
                    }
                    const fileMap = symbolsByDomain.get(domain)!;
                    if (!fileMap.has(symbol.filePath)) {
                        fileMap.set(symbol.filePath, []);
                    }
                    fileMap.get(symbol.filePath)!.push(symbol);
                });

                // Create file and symbol nodes grouped by domain
                const fileNodes: Node[] = [];
                const symbolNodes: Node[] = [];

                for (const [domain, fileMap] of symbolsByDomain) {
                    for (const [filePath, symbols] of fileMap) {
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

                        // Create file node as child of domain
                        fileNodes.push({
                            id: filePath,
                            type: 'fileNode',
                            position: { x: 0, y: 0 },
                            data: {
                                filePath,
                                symbolCount: symbols.length,
                                avgCoupling,
                                collapsed: false,
                            },
                            parentId: `domain:${domain}`,
                            extent: 'parent',
                        });

                        // Create symbol nodes as children of file nodes
                        symbols.forEach((symbol) => {
                            const key = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
                            const coupling = metrics.get(key) || {
                                nodeId: key,
                                inDegree: 0,
                                outDegree: 0,
                                cbo: 0,
                                normalizedScore: 0,
                                color: '#3b82f6',
                            };

                            symbolNodes.push({
                                id: key,
                                type: 'symbolNode',
                                position: { x: 0, y: 0 },
                                data: {
                                    label: symbol.name,
                                    symbolType: symbol.type,
                                    complexity: symbol.complexity,
                                    coupling,
                                    filePath: symbol.filePath,
                                    line: symbol.range.startLine,
                                },
                                parentId: symbol.filePath,
                                extent: 'parent',
                            });
                        });
                    }
                }

                // Create edges
                const rawEdges: Edge[] = graphData.edges.map((edge, index) => ({
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
                const optimizedEdges = optimizeEdges(rawEdges, 1000);

                // Apply layout with domain hierarchy
                const { nodes: layoutedNodes, edges: layoutedEdges } = await applyElkLayout(
                    [...domainNodes, ...fileNodes, ...symbolNodes],
                    optimizedEdges
                );

                setNodes(layoutedNodes);
                setEdges(layoutedEdges);
            } catch (error) {
                console.error('Layout failed:', error);
            } finally {
                setIsLayouting(false);
            }
        };

        runLayout();
    }, [graphData, setNodes, setEdges]);

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
        <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            {isLayouting && (
                <div className="absolute inset-0 flex items-center justify-center bg-black bg-opacity-50 z-50">
                    <div className="text-white font-semibold">Calculating Layout...</div>
                </div>
            )}
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
        </div>
    );
});

GraphCanvas.displayName = 'GraphCanvas';

export default GraphCanvas;
