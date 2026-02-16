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
import type { GraphData, DomainNodeData, FileNodeData, SymbolNodeData, SkeletonNodeData, VSCodeAPI } from '../types';
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
    const [miniMapVisible, setMiniMapVisible] = useState(true);
    const [hasInitialFit, setHasInitialFit] = useState(false);

    // Architecture Filtering & Sorting State
    const [selectedDomain, setSelectedDomain] = useState<string>('All');
    const [sortBy, setSortBy] = useState<'name' | 'complexity' | 'fragility' | 'blastRadius'>('name');

    // Extract available domains from architecture skeleton
    const availableDomains = useMemo(() => {
        if (!architectureSkeleton) return [];
        const domains = new Set<string>();

        const traverse = (nodes: SkeletonNodeData[]) => {
            for (const n of nodes) {
                // Priority 1: Explicitly classified domains
                if (n.domainName) {
                    domains.add(n.domainName);
                }

                // Priority 2: Folder names (at depth 0 or 1) as proxy domains
                // This handles projects without AI analysis gracefully.
                if (n.isFolder && n.depth <= 1) {
                    domains.add(n.name);
                }

                if (n.children) traverse(n.children);
            }
        };

        traverse(architectureSkeleton.nodes);
        return Array.from(domains).sort();
    }, [architectureSkeleton]);

    // Execution flows for flow mode
    const [executionFlows, setExecutionFlows] = useState<ReturnType<typeof detectExecutionFlows>>([]);

    // BFS Tree Depth control (0: Domain, 1: File, 2: Symbol)
    const [maxDepth, setMaxDepth] = useState(2);

    // Build all nodes and edges from graph data (only when data changes)
    useEffect(() => {
        const buildNodes = async () => {
            // Mode: Architecture (Macro View)
            if (currentMode === 'architecture' && architectureSkeleton) {
                const nodes: Node[] = [];
                const structureEdges: Edge[] = [];

                // Helper to sort nodes recursively
                const sortNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
                    return [...nodes].sort((a, b) => {
                        switch (sortBy) {
                            case 'complexity':
                                return (b.avgComplexity || 0) - (a.avgComplexity || 0);
                            case 'fragility':
                                return (b.avgFragility || 0) - (a.avgFragility || 0);
                            case 'blastRadius':
                                return (b.totalBlastRadius || 0) - (a.totalBlastRadius || 0);
                            case 'name':
                            default:
                                return a.name.localeCompare(b.name);
                        }
                    }).map(node => ({
                        ...node,
                        children: node.children ? sortNodes(node.children) : undefined
                    }));
                };

                // Helper to filter nodes recursively
                const filterNodes = (nodes: SkeletonNodeData[]): SkeletonNodeData[] => {
                    if (selectedDomain === 'All') return nodes;

                    return nodes.reduce<SkeletonNodeData[]>((acc, node) => {
                        // Check for domain match or folder name match
                        const isMatch = node.domainName === selectedDomain || node.name === selectedDomain;

                        if (isMatch) {
                            // If this node matches, we keep it and its entire sub-hierarchy
                            acc.push(node);
                        } else if (node.children) {
                            // Otherwise, check if any of its children match
                            const filteredChildren = filterNodes(node.children);
                            if (filteredChildren.length > 0) {
                                // Keep this container node but with only matching children
                                acc.push({ ...node, children: filteredChildren });
                            }
                        }
                        return acc;
                    }, []);
                };

                // Apply Sorting & Filtering
                let processedSkeleton = sortNodes(architectureSkeleton!.nodes);
                processedSkeleton = filterNodes(processedSkeleton);

                // Helper to calculate health from node metrics
                const calculateNodeHealth = (n: SkeletonNodeData) => {
                    // 1. Complexity Score (Lower is better)
                    // limit 20 as "max reasonable average complexity"
                    const complexityScore = Math.max(0, 100 - (n.avgComplexity / 20) * 100);

                    // 2. Fragility/Coupling Score (Lower is better)
                    // limit 50 as "max reasonable average fragility"
                    const fragilityScore = Math.max(0, 100 - (n.avgFragility / 50) * 100);

                    // Weighted Average (60% Complexity, 40% Fragility)
                    const healthScore = Math.round(complexityScore * 0.6 + fragilityScore * 0.4);

                    let status: 'healthy' | 'warning' | 'critical' = 'healthy';
                    if (healthScore < 60) status = 'critical';
                    else if (healthScore < 80) status = 'warning';

                    return {
                        healthScore,
                        status,
                        // Map fragility to a 0-1 scale for the "Coupling" display
                        coupling: Math.min(1, n.avgFragility / 50)
                    };
                };

                const processRecursiveNodes = (skeletonNodes: SkeletonNodeData[], parentId?: string, parentDomain?: string, depth = 0) => {
                    // Depth 0: Show only Top-Level Domains (recursion blocked below)
                    // Depth 1: Show Domains + Nested Folders (Files skipped)
                    // Depth 2: Show Everything

                    for (const n of skeletonNodes) {
                        // Filter Logic based on maxDepth
                        if (maxDepth === 0 && depth > 0) return; // Should not happen due to recursion guard, but safety
                        if (maxDepth === 1 && !n.isFolder) continue; // Skip files in Structure mode

                        const isCollapsed = collapsedNodes.has(n.id);

                        // Only use domainName if it's defined and NOT the same as the parent's domain
                        const effectiveDomain = (n.domainName && n.domainName !== parentDomain)
                            ? n.domainName
                            : n.name;

                        // Linked Hierarchy Logic:
                        // If it's a folder, it becomes a top-level node (no parentId) regardless of depth
                        // If it's a file, it stays inside its parent folder (parentId is preserved)
                        const nodeParentId = n.isFolder ? undefined : parentId;

                        nodes.push({
                            id: n.id,
                            type: n.isFolder ? 'domainNode' : 'fileNode',
                            position: { x: 0, y: 0 },
                            parentId: nodeParentId,
                            extent: n.isFolder ? undefined : 'parent',
                            data: n.isFolder ? {
                                domain: effectiveDomain,
                                health: {
                                    domain: effectiveDomain,
                                    status: calculateNodeHealth(n).status,
                                    healthScore: calculateNodeHealth(n).healthScore,
                                    avgComplexity: n.avgComplexity,
                                    coupling: calculateNodeHealth(n).coupling,
                                    symbolCount: n.symbolCount,
                                    avgFragility: n.avgFragility,
                                    totalBlastRadius: n.totalBlastRadius
                                },
                                collapsed: isCollapsed,
                                onToggleCollapse: () => toggleNodeCollapse(n.id),
                            } as DomainNodeData : {
                                filePath: n.id,
                                symbolCount: n.symbolCount,
                                avgCoupling: 0,
                                avgFragility: n.avgFragility,
                                totalBlastRadius: n.totalBlastRadius,
                                collapsed: false,
                                onToggleCollapse: undefined,
                                label: n.name,
                                domainName: n.domainName
                            } as FileNodeData,
                        });

                        // If parent exists and this is a folder, create a structural edge
                        if (parentId && n.isFolder) {
                            structureEdges.push({
                                id: `struct-${parentId}-${n.id}`,
                                source: parentId,
                                target: n.id,
                                type: 'smoothstep',
                                animated: false,
                                style: {
                                    stroke: '#6b7280',
                                    strokeWidth: 2,
                                    strokeDasharray: '5,5',
                                    opacity: 0.5
                                },
                                label: 'contains'
                            });
                        }

                        // Recursion Logic
                        // If maxDepth is 0, we do NOT recurse (showing only top level)
                        const shouldRecurse = maxDepth > 0 && !isCollapsed && n.children && n.children.length > 0;

                        if (shouldRecurse) {
                            processRecursiveNodes(n.children!, n.id, n.domainName || parentDomain, depth + 1);
                        }
                    }
                };

                processRecursiveNodes(processedSkeleton);

                const dependencyEdges: Edge[] = architectureSkeleton!.edges.map((e, i) => ({
                    id: `skel-edge-${i}`,
                    source: e.source,
                    target: e.target,
                    type: 'default',
                    label: e.weight > 1 ? e.weight.toString() : undefined,
                    style: { strokeWidth: Math.min(e.weight, 5) }
                }));

                setAllNodes(nodes);
                setAllEdges([...structureEdges, ...dependencyEdges]);
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
                        complexity: n.complexity,
                        blastRadius: n.blastRadius,
                        filePath: n.filePath,
                        line: n.line,
                        isSink: n.isSink,
                        coupling: { color: n.isSink ? '#ef4444' : '#3b82f6' } as any
                    } as SymbolNodeData,
                }));

                const edges: Edge[] = functionTrace.edges.map((e, i) => {
                    const targetNode = functionTrace.nodes.find(n => n.id === e.target);
                    const isTargetComplex = targetNode ? targetNode.complexity > 10 : false;

                    return {
                        id: `trace-edge-${i}`,
                        source: e.source,
                        target: e.target,
                        type: 'smoothstep',
                        animated: true,
                        style: { stroke: isTargetComplex ? '#ef4444' : '#3b82f6' }
                    };
                });

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
    }, [graphData, currentMode, collapsedNodes, toggleNodeCollapse, architectureSkeleton, functionTrace, selectedDomain, sortBy, maxDepth]);



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

    // Handle search-driven focus (Only happens when searchQuery changes)
    useEffect(() => {
        if (searchQuery && searchQuery.length > 2 && visibleNodes.length > 0) {
            // Find first node that matches search
            const match = visibleNodes.find(n =>
                (n.data as any).name?.toLowerCase().includes(searchQuery.toLowerCase()) ||
                (n.data as any).label?.toLowerCase().includes(searchQuery.toLowerCase())
            );
            if (match) {
                focusNode(match.id);
            }
        }
    }, [searchQuery, focusNode]); // Only depend on searchQuery change

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

    // Highlight nodes and edges on hover with rich aesthetics
    const { interactiveNodes, interactiveNodesDict } = useMemo(() => {
        if (!hoveredNodeId) return { interactiveNodes: nodes, interactiveNodesDict: new Set(nodes.map(n => n.id)) };

        // Identify connected nodes
        const connectedIds = new Set<string>([hoveredNodeId]);
        edges.forEach(edge => {
            if (edge.source === hoveredNodeId) connectedIds.add(edge.target);
            if (edge.target === hoveredNodeId) connectedIds.add(edge.source);
        });

        const themedNodes = nodes.map(node => {
            const isHovered = node.id === hoveredNodeId;
            const isConnected = connectedIds.has(node.id);

            return {
                ...node,
                style: {
                    ...node.style,
                    opacity: isConnected ? 1 : 0.2,
                    filter: isHovered ? 'drop-shadow(0 0 10px rgba(56, 189, 248, 0.5))' : 'none',
                    transition: 'opacity 0.2s ease, filter 0.2s ease',
                },
            };
        });

        return { interactiveNodes: themedNodes, interactiveNodesDict: connectedIds };
    }, [nodes, edges, hoveredNodeId]);

    const interactiveEdges = useMemo(() => {
        if (!hoveredNodeId) return edges;

        return edges.map((edge) => {
            const isOutgoing = edge.source === hoveredNodeId;
            const isIncoming = edge.target === hoveredNodeId;
            const isConnected = isOutgoing || isIncoming;
            const isStructural = edge.id.startsWith('struct-');

            if (isConnected) {
                // Sky Blue for calls (outgoing), Amber for active path (incoming)
                const highlightColor = isOutgoing ? '#38bdf8' : '#f59e0b';

                return {
                    ...edge,
                    type: isStructural ? 'smoothstep' : 'default', // Using 'default' (bezier) for smoother look on highlight
                    style: {
                        ...edge.style,
                        opacity: 1.0,
                        strokeWidth: 4,
                        stroke: isStructural ? '#ffffff' : highlightColor,
                        strokeDasharray: isStructural ? '5,5' : '0',
                        filter: isStructural ? 'none' : `drop-shadow(0 0 8px ${highlightColor})`,
                    },
                    markerEnd: {
                        ...(edge.markerEnd as any),
                        color: isStructural ? '#ffffff' : highlightColor,
                        width: 25,
                        height: 25,
                    },
                    zIndex: 1000,
                };
            }
            return {
                ...edge,
                style: {
                    ...edge.style,
                    opacity: 0.05,
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

    // Handle node double click to open file
    const handleNodeDoubleClick = useCallback(
        (_event: React.MouseEvent, node: Node) => {
            if (node.type === 'symbolNode' || node.type === 'fileNode' || node.type === 'file') {
                // Verify data exists
                const data = node.data as any;
                if (data.filePath) {
                    vscode.postMessage({
                        type: 'open-file',
                        filePath: data.filePath,
                        line: data.line || 0
                    });
                }
            }
        },
        [vscode]
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

    if (!graphData && !(currentMode === 'trace' && functionTrace) && !(currentMode === 'architecture' && architectureSkeleton)) {
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


    // Safety check: Avoid rendering empty graph containers which might cause issues
    if (nodes.length === 0 && !isLayouting) {
        // CASE 1: Filtered results are empty (Only if a specific domain is selected)
        if (selectedDomain !== 'All' &&
            ((currentMode === 'architecture' && architectureSkeleton) || (currentMode === 'flow' && graphData))) {
            return (
                <div className="flex items-center justify-center w-full h-full">
                    <div className="text-center">
                        <div className="text-lg font-semibold mb-2">No Matching Nodes</div>
                        <div className="text-sm opacity-70 mb-4">
                            The current filter (Domain: {selectedDomain}) matches no files in this view.
                        </div>
                        <button
                            onClick={() => setSelectedDomain('All')}
                            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-md text-sm transition-colors"
                        >
                            Reset Filter
                        </button>
                    </div>
                </div>
            );
        }

        // CASE 2: Still Processing / Calculating Layout
        return (
            <div className="flex items-center justify-center w-full h-full">
                <div className="text-center">
                    <div style={{ fontSize: '24px', marginBottom: '16px', color: 'var(--vscode-textLink-foreground)' }}>⟳</div>
                    <div className="text-sm opacity-70">Preparing Graph Visualization...</div>
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
                availableDomains={availableDomains}
                selectedDomain={selectedDomain}
                onSelectDomain={setSelectedDomain}
                sortBy={sortBy}
                onSortChange={setSortBy as any}
            />

            <div style={{ flex: 1, position: 'relative' }}>
                <ReactFlow
                    nodes={interactiveNodes}
                    edges={interactiveEdges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onNodeClick={handleNodeClick}
                    onNodeDoubleClick={handleNodeDoubleClick}
                    onNodeMouseEnter={handleNodeMouseEnter}
                    onNodeMouseLeave={handleNodeMouseLeave}
                    nodeTypes={nodeTypes}
                    minZoom={0.1}
                    maxZoom={2}
                    nodesDraggable={false}
                    nodesConnectable={false}
                    elementsSelectable={true}
                    onlyRenderVisibleElements={true}
                    elevateEdgesOnSelect={false}
                    zoomOnDoubleClick={false}
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

                    {/* Legend */}
                    <div style={{
                        position: 'absolute',
                        bottom: '20px',
                        left: '20px',
                        backgroundColor: 'var(--vscode-editor-background)',
                        border: '1px solid var(--vscode-widget-border)',
                        padding: '12px',
                        borderRadius: '8px',
                        fontSize: '11px',
                        boxShadow: '0 4px 6px rgba(0,0,0,0.3)',
                        zIndex: 10,
                        opacity: 0.9,
                        color: 'var(--vscode-editor-foreground)',
                        pointerEvents: 'none' // Let clicks pass through if needed, but usually legend is just visual
                    }}>
                        <div style={{ fontWeight: 600, marginBottom: '8px', opacity: 0.8, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Relationships</div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ width: '24px', height: '2px', backgroundColor: '#6b7280', borderTop: '2px dashed #6b7280' }}></div>
                            <span>Hierarchy (Contains)</span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
                            <div style={{ width: '24px', height: '3px', backgroundColor: '#38bdf8' }}></div>
                            <span>Calls / Dependencies</span>
                        </div>

                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <div style={{ width: '24px', height: '3px', backgroundColor: '#f59e0b', boxShadow: '0 0 4px #f59e0b' }}></div>
                            <span>Active Path / Selection</span>
                        </div>
                    </div>
                </ReactFlow>
            </div>
        </div>
    );
});

GraphCanvas.displayName = 'GraphCanvas';

export default GraphCanvas;
