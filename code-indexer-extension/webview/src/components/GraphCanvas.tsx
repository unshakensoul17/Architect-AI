import { memo, useCallback, useEffect, useState, useMemo, useRef } from 'react';
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
import { perfMonitor } from '../utils/performance-monitor';
import { applyBFSLayout } from '../utils/bfs-layout';

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
    const { collapsedNodes, toggleNodeCollapse, architectureSkeleton, functionTrace } = useGraphStore();

    // React Flow instance for focus engine
    const reactFlowInstance = useReactFlow();
    const { focusNode, clearFocus } = useFocusEngine(reactFlowInstance);

    // Track if we've done the initial fitView to prevent blinking
    const [hasInitialFit, setHasInitialFit] = useState(false);

    // Execution flows for flow mode
    const [executionFlows, setExecutionFlows] = useState<ReturnType<typeof detectExecutionFlows>>([]);

    // BFS Tree Depth control (0: Domain, 1: File, 2: Symbol)
    const [maxDepth, setMaxDepth] = useState(2);

    // Build all nodes and edges from graph data (only when data changes)
    useEffect(() => {
        const buildNodes = async () => {
            // Mode: Architecture (Macro View)
            if (currentMode === 'architecture' && architectureSkeleton) {
                const nodes: Node[] = architectureSkeleton.nodes.map(n => ({
                    id: n.id,
                    type: 'fileNode',
                    position: { x: 0, y: 0 },
                    data: {
                        filePath: n.id,
                        symbolCount: n.symbolCount,
                        avgCoupling: 0,
                        avgFragility: n.avgFragility,
                        totalBlastRadius: n.totalBlastRadius,
                        collapsed: false,
                        onToggleCollapse: undefined,
                        label: n.name
                    } as FileNodeData,
                }));

                const edges: Edge[] = architectureSkeleton.edges.map((e, i) => ({
                    id: `skel-edge-${i}`,
                    source: e.source,
                    target: e.target,
                    type: 'default',
                    label: e.weight > 1 ? e.weight.toString() : undefined,
                    style: { strokeWidth: Math.min(e.weight, 5) }
                }));

                setAllNodes(nodes);
                setAllEdges(edges);
                return;
            }

            // Mode: Trace (Micro View)
            if (currentMode === 'trace' && functionTrace) {
                const nodes: Node[] = functionTrace.nodes.map(n => ({
                    id: n.id,
                    type: 'symbolNode',
                    position: { x: 0, y: 0 }, // Let layout engine handle it
                    data: {
                        label: n.label,
                        symbolType: n.type as any,
                        complexity: 0,
                        blastRadius: n.blastRadius,
                        filePath: n.filePath,
                        line: n.line,
                        isSink: n.isSink,
                        coupling: { color: n.isSink ? '#ef4444' : '#3b82f6' } as any
                    } as SymbolNodeData,
                }));

                const edges: Edge[] = functionTrace.edges.map((e, i) => ({
                    id: `trace-edge-${i}`,
                    source: e.source,
                    target: e.target,
                    type: 'smoothstep',
                    animated: true,
                    style: { stroke: '#3b82f6' }
                }));

                setAllNodes(nodes);
                setAllEdges(edges);
                return;
            }

            // Default Mode: Full Graph (Flow, Risk, Impact, etc.)
            if (!graphData) {
                setAllNodes([]);
                setAllEdges([]);
                clearLayoutCache();
                clearRelationshipCache();
                return;
            }

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
                const domainNodeId = `domain:${domain}`;
                if (collapsedNodes.has(domainNodeId)) continue; // Optimization: Don't create children if collapsed

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

            // Edge Redirection Logic for Full Graph
            const visibleNodeIds = new Set([
                ...domainNodes.map(n => n.id),
                ...fileNodes.map(n => n.id),
                ...symbolNodes.map(n => n.id)
            ]);

            const nodeRedirection = new Map<string, string>();
            graphData.symbols.forEach(symbol => {
                const symbolId = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
                const domainId = `domain:${symbol.domain || 'unknown'}`;
                const fileId = `${symbol.domain || 'unknown'}:${symbol.filePath}`;

                if (collapsedNodes.has(domainId)) {
                    nodeRedirection.set(symbolId, domainId);
                } else if (collapsedNodes.has(fileId)) {
                    nodeRedirection.set(symbolId, fileId);
                }
            });

            const processedEdges: Edge[] = [];
            const uniqueEdges = new Set<string>();

            graphData.edges.forEach((edge, index) => {
                let source = edge.source;
                let target = edge.target;

                if (nodeRedirection.has(source)) source = nodeRedirection.get(source)!;
                if (nodeRedirection.has(target)) target = nodeRedirection.get(target)!;

                if (source !== target && visibleNodeIds.has(source) && visibleNodeIds.has(target)) {
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

            const optimizedEdges = optimizeEdges(processedEdges, 10000);
            setAllNodes([...domainNodes, ...fileNodes, ...symbolNodes]);
            setAllEdges(optimizedEdges);

            const flows = detectExecutionFlows(graphData);
            setExecutionFlows(flows);
        };

        buildNodes();
        setHasInitialFit(false);
    }, [graphData, currentMode, collapsedNodes, toggleNodeCollapse, architectureSkeleton, functionTrace]);



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

        // Deduplicate nodes by ID (Prevents the "stacking" ghost nodes seen in the UI)
        const uniqueNodesMap = new Map<string, Node>();
        result.visibleNodes.forEach(node => {
            if (!uniqueNodesMap.has(node.id)) {
                uniqueNodesMap.set(node.id, node);
            }
        });
        const finalNodes = Array.from(uniqueNodesMap.values());

        // Additionally filter by depth in flow mode
        if (currentMode === 'flow') {
            const depthFilteredNodes = finalNodes.filter(node => {
                if (maxDepth === 0) return node.type === 'domainNode';
                if (maxDepth === 1) return node.type === 'domainNode' || node.type === 'fileNode';
                return true; // maxDepth 2: All nodes
            });

            const depthFilteredNodeIds = new Set(depthFilteredNodes.map(n => n.id));
            const depthFilteredEdges = result.visibleEdges.filter(edge =>
                depthFilteredNodeIds.has(edge.source) && depthFilteredNodeIds.has(edge.target)
            );

            return { visibleNodes: depthFilteredNodes, visibleEdges: depthFilteredEdges };
        }

        const filterTime = perfMonitor.endTimer('filter');
        perfMonitor.recordMetrics({
            filterTime,
            nodeCount: finalNodes.length,
            edgeCount: result.visibleEdges.length,
        });

        return { visibleNodes: finalNodes, visibleEdges: result.visibleEdges };
    }, [allNodes, allEdges, currentMode, focusedNodeId, relatedNodeIdsKey, executionFlows, searchQuery, maxDepth]);

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
                    let layoutedNodes: Node[];
                    let layoutedEdges: Edge[];

                    if (currentMode === 'flow' || currentMode === 'trace') {
                        // Use BFS layout for flow and trace mode
                        // For trace, try to root at the first node
                        const rootNodeId = currentMode === 'trace' ? visibleNodes[0]?.id : (focusedNodeId || undefined);
                        const result = applyBFSLayout(
                            visibleNodes,
                            visibleEdges,
                            rootNodeId,
                            currentMode === 'trace' ? 'RIGHT' : 'DOWN',
                            currentMode === 'trace' // forceGrid for trace
                        );
                        layoutedNodes = result.nodes;
                        layoutedEdges = result.edges;
                    } else {
                        const result = await applyElkLayout(
                            visibleNodes,
                            visibleEdges,
                            { viewMode: currentMode }
                        );
                        layoutedNodes = result.nodes;
                        layoutedEdges = result.edges;
                    }

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

    // Re-focus on node when nodes change (e.g. after layout)
    useEffect(() => {
        if (focusedNodeId && nodes.length > 0 && !isLayouting) {
            focusNode(focusedNodeId);
        }
    }, [focusedNodeId, nodes, isLayouting, focusNode]);

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
            // Set local focus
            setFocusedNodeId(node.id);
            focusNode(node.id);

            // Also notify parent
            if (onNodeClick) {
                onNodeClick(node.id);
            }
        },
        [onNodeClick, setFocusedNodeId, focusNode]
    );

    // Handle mode change
    const handleModeChange = useCallback(
        (mode: ViewMode) => {
            switchMode(mode);
            setFocusedNodeId(null);
            clearFocus();
        },
        [switchMode, setFocusedNodeId, clearFocus]
    );

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
        if (currentMode === 'trace' && !functionTrace) {
            return (
                <div className="flex items-center justify-center w-full h-full">
                    <div className="text-center p-8 border-2 border-dashed border-white border-opacity-10 rounded-xl bg-black bg-opacity-20 max-w-md">
                        <div className="text-5xl mb-6">🔍</div>
                        <h2 className="text-xl font-bold mb-3 text-white">No Active Function Trace</h2>
                        <p className="text-sm opacity-70 mb-6 leading-relaxed">
                            To visualize a micro-trace, open a source file in the editor and click the
                            <span className="mx-1 px-1.5 py-0.5 rounded bg-blue-500 bg-opacity-20 text-blue-400 font-mono text-xs border border-blue-500 border-opacity-30">Trace</span>
                            CodeLens above any function definition.
                        </p>
                        <div className="text-xs opacity-50 italic">
                            Micro-traces help you navigate deep execution paths and identify sinks.
                        </div>
                    </div>
                </div>
            );
        }
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
            <ViewModeBar
                currentMode={currentMode}
                onModeChange={handleModeChange}
                maxDepth={maxDepth}
                onDepthChange={setMaxDepth}
            />

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
            </div>
        </div>
    );
});

GraphCanvas.displayName = 'GraphCanvas';

export default GraphCanvas;
