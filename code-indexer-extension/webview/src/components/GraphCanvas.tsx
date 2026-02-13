import { memo, useCallback, useEffect, useState, useMemo } from 'react';
import {
    ReactFlow,
    Background,
    Controls,
    MiniMap,
    useNodesState,
    useEdgesState,
    useReactFlow,
    type Node,
    type Edge,
    type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import FileNode from './FileNode';
import SymbolNode from './SymbolNode';
import DomainNode from './DomainNode';
import ViewModeBar from './ViewModeBar';
import ImpactSidePanel from './ImpactSidePanel';
import type { GraphData, DomainNodeData, FileNodeData, SymbolNodeData, VSCodeAPI } from '../types';
import type { ViewMode, FilterContext } from '../types/viewMode';
import { DEFAULT_RISK_THRESHOLDS } from '../types/viewMode';
import { useViewMode } from '../hooks/useViewMode';
import { useGraphStore } from '../stores/useGraphStore';
import { useFocusEngine } from '../hooks/useFocusEngine';
import { calculateCouplingMetrics } from '../utils/metrics';
import { applyElkLayout, clearLayoutCache } from '../utils/elk-layout';
import { optimizeEdges } from '../utils/performance';
import { applyViewMode as applyGraphFilter } from '../utils/graphFilter';
import { getRelatedNodes, clearRelationshipCache } from '../utils/relationshipDetector';
import { detectExecutionFlows } from '../utils/flowDetector';
import { analyzeImpact } from '../utils/impactAnalyzer';
import { perfMonitor } from '../utils/performance-monitor';

interface GraphCanvasProps {
    graphData: GraphData | null;
    vscode: VSCodeAPI;
    onNodeClick?: (nodeId: string) => void;
    searchQuery?: string;
}

const nodeTypes: NodeTypes = {
    fileNode: FileNode,
    symbolNode: SymbolNode,
    domainNode: DomainNode,
};

const GraphCanvas = memo(({ graphData, vscode, onNodeClick, searchQuery }: GraphCanvasProps) => {
    const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
    const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [allNodes, setAllNodes] = useState<Node[]>([]);
    const [allEdges, setAllEdges] = useState<Edge[]>([]);
    const [isLayouting, setIsLayouting] = useState(false);

    // View mode state
    const {
        currentMode,
        switchMode,
        focusedNodeId,
        setFocusedNodeId,
        relatedNodeIds,
        setRelatedNodeIds,
        impactStats,
        setImpactStats,
    } = useViewMode(vscode, searchQuery);

    // Graph Store
    const { collapsedNodes, toggleNodeCollapse } = useGraphStore();

    // React Flow instance for focus engine
    const reactFlowInstance = useReactFlow();
    const { focusNode, clearFocus } = useFocusEngine(reactFlowInstance);

    // Track if we've done the initial fitView to prevent blinking
    const [hasInitialFit, setHasInitialFit] = useState(false);

    // Execution flows for flow mode
    const [executionFlows, setExecutionFlows] = useState<ReturnType<typeof detectExecutionFlows>>([]);

    // Build all nodes and edges from graph data (only when data changes)
    useEffect(() => {
        if (!graphData) {
            setAllNodes([]);
            setAllEdges([]);
            clearLayoutCache();
            clearRelationshipCache();
            return;
        }

        const buildNodes = async () => {
            // Calculate coupling metrics
            const metrics = calculateCouplingMetrics(graphData);

            // Create domain nodes (top level)
            const domainNodes: Node[] = graphData.domains.map((domainData) => {
                const nodeId = `domain:${domainData.domain}`;
                const isCollapsed = collapsedNodes.has(nodeId);

                return {
                    id: nodeId,
                    type: 'domainNode',
                    position: { x: 0, y: 0 },
                    data: {
                        domain: domainData.domain,
                        health: domainData.health,
                        collapsed: isCollapsed,
                        onToggleCollapse: () => toggleNodeCollapse(nodeId),
                    } as DomainNodeData,
                };
            });

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
                // If domain is collapsed, skip processing children for layout/visibility
                // We will rely on React Flow or ELK layout to handle hiding? 
                // Actually, if we remove them from `nodes`, they won't render.
                // However, ELK needs to know about them if we want to "keep them inside" but hidden?
                // No, usually we remove them from the graph.
                const domainNodeId = `domain:${domain}`;
                if (collapsedNodes.has(domainNodeId)) continue;

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
                    const fileNodeId = `${domain}:${filePath}`;
                    const isFileCollapsed = collapsedNodes.has(fileNodeId);

                    fileNodes.push({
                        id: fileNodeId,
                        type: 'fileNode',
                        position: { x: 0, y: 0 },
                        data: {
                            filePath,
                            symbolCount: symbols.length,
                            avgCoupling,
                            collapsed: isFileCollapsed,
                            onToggleCollapse: () => toggleNodeCollapse(fileNodeId),
                        } as FileNodeData,
                        parentId: domainNodeId,
                        extent: 'parent',
                    });

                    // If file is collapsed, skip symbols
                    if (isFileCollapsed) continue;

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
                            } as SymbolNodeData,
                            parentId: fileNodeId,
                            extent: 'parent',
                        });
                    });
                }
            }

            // Create edges
            // We need to filter edges to only include those where both source and target are visible
            // OR if a parent is collapsed, redirect edges to the parent.
            // Simplified approach: Only show edges between visible nodes.
            // Advanced approach (Edge Bundling to Cluster): Redirect edge to parent.

            // Let's implement redirection logic.
            const visibleNodeIds = new Set([
                ...domainNodes.map(n => n.id),
                ...fileNodes.map(n => n.id),
                ...symbolNodes.map(n => n.id)
            ]);

            // Helper to get effective node ID (itself or its visible parent)
            // This maps a potentially hidden node to its visible ancestor
            // Map: [Symbol ID] -> [File ID] (if file collapsed) -> [Domain ID] (if domain collapsed)
            // But wait, `visibleNodeIds` only contains expanded nodes.
            // We need a map of ALL nodes to their visible representative.

            // Build a map of all symbols/files to their visible ancestor.
            const nodeRedirection = new Map<string, string>();

            // We iterate over the original data structure again? 
            // Or just use the known structure.
            graphData.symbols.forEach(symbol => {
                const symbolId = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
                const domainId = `domain:${symbol.domain || 'unknown'}`;
                const fileId = `${symbol.domain || 'unknown'}:${symbol.filePath}`;

                if (collapsedNodes.has(domainId)) {
                    nodeRedirection.set(symbolId, domainId);
                } else if (collapsedNodes.has(fileId)) {
                    nodeRedirection.set(symbolId, fileId);
                } else {
                    // It is visible itself
                    // nodeRedirection.set(symbolId, symbolId);
                }
            });

            // Also map files to domains if domain is collapsed
            graphData.files.forEach(file => {
                // We need domain info for file. `GraphData.files` doesn't have it easily.
                // We derived it from symbols. 
                // Let's assume we can skip this precision or handle it via symbol iteration.
            });

            // Check edges
            const processedEdges: Edge[] = [];
            const uniqueEdges = new Set<string>();

            graphData.edges.forEach((edge, index) => {
                let source = edge.source;
                let target = edge.target;

                // Apply redirection
                if (nodeRedirection.has(source)) source = nodeRedirection.get(source)!;
                if (nodeRedirection.has(target)) target = nodeRedirection.get(target)!;

                // Only add if source != target (ignore self-loops after collapse)
                if (source !== target && visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
                    // Check for duplicates
                    const key = `${source}-${target}-${edge.type}`;
                    if (!uniqueEdges.has(key)) {
                        uniqueEdges.add(key);
                        processedEdges.push({
                            id: `edge-${index}`,
                            source,
                            target,
                            type: 'smoothstep',
                            animated: edge.type === 'call',
                            style: {
                                stroke: edge.type === 'call' ? '#3b82f6' : edge.type === 'import' ? '#10b981' : '#6b7280',
                                strokeWidth: 1.5,
                            },
                        });
                    }
                }
            });

            // Optimize edges for performance
            // Increased limit to prevent breaking analysis features (flow/impact)
            // when many nodes are uncollapsed
            const optimizedEdges = optimizeEdges(processedEdges, 10000);

            setAllNodes([...domainNodes, ...fileNodes, ...symbolNodes]);
            setAllEdges(optimizedEdges);

            // Detect execution flows for flow mode
            const flows = detectExecutionFlows(graphData);
            setExecutionFlows(flows);
        };

        buildNodes();
        // Reset initial fit when graph data changes
        setHasInitialFit(false);
    }, [graphData, collapsedNodes, toggleNodeCollapse]);

    // Memoize impact analysis to prevent redundant calculations
    const impactAnalysis = useMemo(() => {
        if (!focusedNodeId || currentMode !== 'impact' || allNodes.length === 0) {
            return null;
        }

        // Get related nodes
        const related = getRelatedNodes(focusedNodeId, allNodes, allEdges, 2);

        // Analyze impact
        const impact = analyzeImpact(focusedNodeId, allNodes, allEdges);

        return {
            relatedNodeIds: related.all,
            impactStats: impact.stats,
        };
    }, [focusedNodeId, currentMode, allNodes, allEdges]);

    // Update state when impact analysis changes
    useEffect(() => {
        if (impactAnalysis) {
            setRelatedNodeIds(impactAnalysis.relatedNodeIds);
            setImpactStats(impactAnalysis.impactStats);
            focusNode(focusedNodeId!);
        } else if (!focusedNodeId) {
            setRelatedNodeIds(new Set());
            setImpactStats(null);
        }
    }, [impactAnalysis, focusedNodeId, setRelatedNodeIds, setImpactStats, focusNode]);

    // Create stable dependency for relatedNodeIds (Set creates new reference each time)
    const relatedNodeIdsKey = useMemo(
        () => Array.from(relatedNodeIds).sort().join(','),
        [relatedNodeIds]
    );

    // Apply filtering based on view mode
    const { visibleNodes, visibleEdges } = useMemo(() => {
        perfMonitor.startTimer('filter');

        if (allNodes.length === 0) {
            return { visibleNodes: [], visibleEdges: [] };
        }

        const context: FilterContext = {
            mode: currentMode,
            focusedNodeId,
            relatedNodeIds,
            riskThresholds: DEFAULT_RISK_THRESHOLDS,
            executionFlows,
            searchQuery,
        };

        const result = applyGraphFilter(allNodes, allEdges, context);

        const filterTime = perfMonitor.endTimer('filter');
        perfMonitor.recordMetrics({
            filterTime,
            nodeCount: result.visibleNodes.length,
            edgeCount: result.visibleEdges.length,
        });

        return result;
    }, [allNodes, allEdges, currentMode, focusedNodeId, relatedNodeIdsKey, executionFlows, searchQuery]);

    // Apply layout when visible nodes change (debounced to prevent rapid re-layouts)
    useEffect(() => {
        if (visibleNodes.length === 0) {
            setNodes([]);
            setEdges([]);
            return;
        }

        // Debounce layout to prevent rapid re-calculations
        const layoutTimer = setTimeout(() => {
            const runLayout = async () => {
                setIsLayouting(true);
                perfMonitor.startTimer('layout');

                try {
                    const { nodes: layoutedNodes, edges: layoutedEdges } = await applyElkLayout(
                        visibleNodes,
                        visibleEdges,
                        { viewMode: currentMode }
                    );

                    setNodes(layoutedNodes);
                    setEdges(layoutedEdges);

                    perfMonitor.endTimer('layout');
                } catch (error) {
                    console.error('Layout failed:', error);
                    // Fallback: use nodes without layout
                    setNodes(visibleNodes);
                    setEdges(visibleEdges);
                    perfMonitor.endTimer('layout');
                } finally {
                    setIsLayouting(false);
                }
            };

            runLayout();
        }, 150); // 150ms debounce

        return () => clearTimeout(layoutTimer);
    }, [visibleNodes, visibleEdges, currentMode, setNodes, setEdges]);

    // Highlight edges on hover
    const interactiveEdges = useMemo(() => {
        if (!hoveredNodeId) return edges;

        return edges.map((edge) => {
            const isConnected = edge.source === hoveredNodeId || edge.target === hoveredNodeId;
            if (isConnected) {
                return {
                    ...edge,
                    style: {
                        ...edge.style,
                        opacity: 1.0,
                        strokeWidth: 3,
                        strokeDasharray: '0', // Make solid for better focus
                    },
                    markerEnd: {
                        ...(edge.markerEnd as any),
                        width: 25,
                        height: 25,
                    }
                };
            }
            return {
                ...edge,
                style: {
                    ...edge.style,
                    opacity: 0.1, // Dim other edges even more
                }
            };
        });
    }, [edges, hoveredNodeId]);

    // Fit view only once when nodes first load (prevents blinking)
    useEffect(() => {
        if (nodes.length > 0 && !hasInitialFit && !isLayouting) {
            // Small delay to ensure layout is complete
            const fitTimer = setTimeout(() => {
                reactFlowInstance.fitView({ padding: 0.1, duration: 200 });
                setHasInitialFit(true);
            }, 100);
            return () => clearTimeout(fitTimer);
        }
    }, [nodes, hasInitialFit, isLayouting, reactFlowInstance]);

    // Handle node hover
    const handleNodeMouseEnter = useCallback((_event: React.MouseEvent, node: Node) => {
        setHoveredNodeId(node.id);
    }, []);

    const handleNodeMouseLeave = useCallback(() => {
        setHoveredNodeId(null);
    }, []);

    // Handle node click based on view mode
    const handleNodeClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            // In impact mode, clicking sets the focused node
            if (currentMode === 'impact') {
                setFocusedNodeId(node.id);
            }

            // Also notify parent
            if (onNodeClick) {
                onNodeClick(node.id);
            }
        },
        [currentMode, setFocusedNodeId, onNodeClick]
    );

    // Handle mode change
    const handleModeChange = useCallback(
        (mode: ViewMode) => {
            switchMode(mode);

            // Clear focus when switching modes (except to impact)
            if (mode !== 'impact') {
                setFocusedNodeId(null);
                clearFocus();
            }
        },
        [switchMode, setFocusedNodeId, clearFocus]
    );

    // Close impact panel
    const handleCloseImpactPanel = useCallback(() => {
        setFocusedNodeId(null);
        setImpactStats(null);
    }, [setFocusedNodeId, setImpactStats]);

    // Get focused node name for impact panel
    const focusedNodeName = useMemo(() => {
        if (!focusedNodeId) return undefined;
        const node = allNodes.find((n) => n.id === focusedNodeId);
        if (!node) return undefined;

        if (node.type === 'symbolNode') {
            return (node.data as SymbolNodeData).label;
        } else if (node.type === 'fileNode') {
            const filePath = (node.data as FileNodeData).filePath;
            return filePath.split('/').pop() || filePath;
        } else if (node.type === 'domainNode') {
            return (node.data as DomainNodeData).domain;
        }

        return undefined;
    }, [focusedNodeId, allNodes]);

    // Memoize MiniMap nodeColor to prevent re-renders
    const miniMapNodeColor = useCallback((node: Node) => {
        if (node.type === 'domainNode') {
            const data = node.data as DomainNodeData;
            const status = data.health?.status || 'healthy';
            return status === 'healthy'
                ? '#10b981'
                : status === 'warning'
                    ? '#fbbf24'
                    : '#ef4444';
        }
        if (node.type === 'fileNode') {
            return '#3b82f6';
        }
        return (node.data as any).coupling?.color || '#6b7280';
    }, []);

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
        <div
            style={{
                width: '100%',
                height: '100%',
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
            }}
        >
            {/* View Mode Bar */}
            <ViewModeBar currentMode={currentMode} onModeChange={handleModeChange} />

            <div style={{ flex: 1, position: 'relative' }}>
                <ReactFlow
                    nodes={nodes}
                    edges={interactiveEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={handleNodeClick}
                    onNodeMouseEnter={handleNodeMouseEnter}
                    onNodeMouseLeave={handleNodeMouseLeave}
                    nodeTypes={nodeTypes}
                    minZoom={0.1}
                    maxZoom={2}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={false}
                    onlyRenderVisibleElements={true}
                    elevateEdgesOnSelect={false}
                    defaultEdgeOptions={{
                        type: 'default',
                    }}
                >
                    <Background gap={20} />
                    <Controls />
                    <MiniMap
                        nodeColor={miniMapNodeColor}
                        maskColor="rgba(0, 0, 0, 0.5)"
                        pannable={false}
                        zoomable={false}
                    />
                </ReactFlow>

                {/* Impact Side Panel */}
                {currentMode === 'impact' && impactStats && (
                    <ImpactSidePanel
                        impactStats={impactStats}
                        focusedNodeName={focusedNodeName}
                        onClose={handleCloseImpactPanel}
                    />
                )}
            </div>
        </div>
    );
});

GraphCanvas.displayName = 'GraphCanvas';

export default GraphCanvas;
