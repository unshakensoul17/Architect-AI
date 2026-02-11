import { useMemo } from 'react';
import type { Node, Edge } from '@xyflow/react';
import type {
    FilterContext,
    NodeVisibilityState,
} from '../types/viewMode';
import { isNodeOnExecutionPath } from './flowDetector';
import type { DomainNodeData, SymbolNodeData } from '../types';

/**
 * Graph Filtering Engine
 * Central filtering system for all view modes
 */

interface FilteredGraph {
    visibleNodes: Node[];
    visibleEdges: Edge[];
}

/**
 * Apply view mode filtering to the entire graph
 * This is the main entry point for filtering
 */
export function applyViewMode(
    allNodes: Node[],
    allEdges: Edge[],
    context: FilterContext
): FilteredGraph {
    switch (context.mode) {
        case 'architecture':
            return filterArchitectureMode(allNodes, allEdges, context);
        case 'flow':
            return filterFlowMode(allNodes, allEdges, context);
        case 'risk':
            return filterRiskMode(allNodes, allEdges, context);
        case 'impact':
            return filterImpactMode(allNodes, allEdges, context);
        default:
            return { visibleNodes: allNodes, visibleEdges: allEdges };
    }
}

/**
 * Architecture Mode: Show domains and files only
 * Purpose: Learn system structure
 */
function filterArchitectureMode(
    allNodes: Node[],
    allEdges: Edge[],
    _context: FilterContext
): FilteredGraph {
    // Filter: Only domain and file nodes
    const visibleNodes = allNodes
        .filter((node) => node.type === 'domainNode' || node.type === 'fileNode')
        .map((node) => {
            const currentOpacity = (node.data as any)?.opacity;
            const currentDisableHeatmap = (node.data as any)?.disableHeatmap;
            const currentHighlight = (node.data as any)?.isHighlighted;

            // Only skip cloning if ALL properties exist and match target state
            if (currentOpacity === 1.0 &&
                currentDisableHeatmap === true &&
                currentHighlight === false) {
                return node;
            }

            return {
                ...node,
                data: {
                    ...node.data,
                    opacity: 1.0,
                    isHighlighted: false,
                    glowColor: undefined,
                    disableHeatmap: true,
                },
            };
        });

    // Filter edges: Only between visible nodes
    const visibleNodeIds = new Set(visibleNodes.map((n) => n.id));
    const visibleEdges = allEdges.filter(
        (edge) => visibleNodeIds.has(edge.source) && visibleNodeIds.has(edge.target)
    );

    return { visibleNodes, visibleEdges };
}

/**
 * Flow Mode: Highlight execution paths
 * Purpose: Understand runtime execution
 */
function filterFlowMode(
    allNodes: Node[],
    allEdges: Edge[],
    context: FilterContext
): FilteredGraph {
    const flows = context.executionFlows || [];

    // Build path node set once
    const pathNodeIds = new Set<string>();
    flows.forEach((flow) => {
        flow.path.forEach((nodeId) => pathNodeIds.add(nodeId));
    });

    // Only clone nodes that need changes
    const visibleNodes = allNodes.map((node) => {
        const isOnPath = pathNodeIds.has(node.id);
        const currentOpacity = (node.data as any)?.opacity;
        const currentHighlight = (node.data as any)?.isHighlighted;
        const currentFlowNode = (node.data as any)?.isFlowNode;
        const targetOpacity = isOnPath ? 1.0 : 0.15;

        // Skip cloning if state hasn't changed (check all properties)
        if (currentOpacity === targetOpacity &&
            currentHighlight === isOnPath &&
            currentFlowNode === isOnPath) {
            return node;
        }

        return {
            ...node,
            data: {
                ...node.data,
                opacity: targetOpacity,
                isHighlighted: isOnPath,
                isFlowNode: isOnPath,
            },
            style: {
                ...node.style,
                opacity: isOnPath ? 1.0 : 0.15,
            },
        };
    });

    // Build edge path set once
    const pathEdges = new Set<string>();
    flows.forEach((flow) => {
        for (let i = 0; i < flow.path.length - 1; i++) {
            pathEdges.add(`${flow.path[i]}->${flow.path[i + 1]}`);
        }
    });

    // Only clone edges that need changes
    const visibleEdges = allEdges.map((edge) => {
        const isOnPath = pathEdges.has(`${edge.source}->${edge.target}`);
        const currentOpacity = edge.style?.opacity;
        const currentAnimated = edge.animated;
        const currentStrokeWidth = edge.style?.strokeWidth;
        const targetOpacity = isOnPath ? 1.0 : 0.15;
        const targetStrokeWidth = isOnPath ? 3 : 1;

        // Skip cloning if state hasn't changed (check all properties)
        if (currentOpacity === targetOpacity &&
            currentAnimated === isOnPath &&
            currentStrokeWidth === targetStrokeWidth) {
            return edge;
        }

        return {
            ...edge,
            style: {
                ...edge.style,
                strokeWidth: isOnPath ? 3 : 1,
                opacity: isOnPath ? 1.0 : 0.15,
            },
            animated: isOnPath,
        };
    });

    return { visibleNodes, visibleEdges };
}

/**
 * Risk Mode: Highlight dangerous code
 * Purpose: Find fragile code
 */
function filterRiskMode(
    allNodes: Node[],
    allEdges: Edge[],
    context: FilterContext
): FilteredGraph {
    const { riskThresholds } = context;

    const visibleNodes = allNodes.map((node) => {
        const riskScore = calculateNodeRisk(node, riskThresholds);
        const isHighRisk = riskScore > 0.6;
        const isMediumRisk = riskScore > 0.3 && riskScore <= 0.6;

        let glowColor: string | undefined;
        if (isHighRisk) {
            glowColor = '#ef4444'; // Red
        } else if (isMediumRisk) {
            glowColor = '#f97316'; // Orange
        }

        const targetOpacity = isHighRisk || isMediumRisk ? 1.0 : 0.3;
        const currentOpacity = (node.data as any)?.opacity;
        const currentGlow = (node.data as any)?.glowColor;
        const currentRiskScore = (node.data as any)?.riskScore;
        const currentHighlight = (node.data as any)?.isHighlighted;

        // Skip cloning if state hasn't changed (check all properties)
        if (currentOpacity === targetOpacity &&
            currentGlow === glowColor &&
            currentRiskScore === riskScore &&
            currentHighlight === (isHighRisk || isMediumRisk)) {
            return node;
        }

        return {
            ...node,
            data: {
                ...node.data,
                opacity: targetOpacity,
                isHighlighted: isHighRisk || isMediumRisk,
                glowColor,
                riskScore,
                disableHeatmap: false,
            },
            style: {
                ...node.style,
                opacity: targetOpacity,
                boxShadow: glowColor ? `0 0 20px ${glowColor}` : undefined,
            },
        };
    });

    // Only clone edges if opacity needs to change
    const visibleEdges = allEdges.map((edge) => {
        const currentOpacity = edge.style?.opacity;
        if (currentOpacity === 0.4) {
            return edge;
        }

        return {
            ...edge,
            style: {
                ...edge.style,
                opacity: 0.4,
            },
        };
    });

    return { visibleNodes, visibleEdges };
}

/**
 * Impact Mode: Show blast radius
 * Purpose: Safe refactoring
 */
function filterImpactMode(
    allNodes: Node[],
    allEdges: Edge[],
    context: FilterContext
): FilteredGraph {
    const { focusedNodeId, relatedNodeIds } = context;

    if (!focusedNodeId) {
        // No node selected, show everything dimmed
        const visibleNodes = allNodes.map((node) => {
            const currentOpacity = (node.data as any)?.opacity;
            if (currentOpacity === 0.4) {
                return node;
            }

            return {
                ...node,
                data: {
                    ...node.data,
                    opacity: 0.4,
                    isHighlighted: false,
                },
                style: {
                    ...node.style,
                    opacity: 0.4,
                },
            };
        });

        return { visibleNodes, visibleEdges: allEdges };
    }

    // Highlight focused node and related nodes
    const visibleNodes = allNodes.map((node) => {
        const isFocused = node.id === focusedNodeId;
        const isRelated = relatedNodeIds.has(node.id);
        const targetOpacity = isFocused || isRelated ? 1.0 : 0.15;
        const currentOpacity = (node.data as any)?.opacity;
        const currentFocused = (node.data as any)?.isFocused;
        const currentHighlight = (node.data as any)?.isHighlighted;

        // Skip cloning if state hasn't changed (check all properties)
        if (currentOpacity === targetOpacity &&
            currentFocused === isFocused &&
            currentHighlight === (isFocused || isRelated)) {
            return node;
        }

        return {
            ...node,
            data: {
                ...node.data,
                opacity: targetOpacity,
                isHighlighted: isFocused || isRelated,
                isFocused,
            },
            style: {
                ...node.style,
                opacity: targetOpacity,
                border: isFocused ? '3px solid #3b82f6' : undefined,
            },
        };
    });

    // Label edges with impact direction
    const visibleEdges = allEdges.map((edge) => {
        const isImpactEdge =
            (edge.source === focusedNodeId && relatedNodeIds.has(edge.target)) ||
            (edge.target === focusedNodeId && relatedNodeIds.has(edge.source));

        let label: string | undefined;
        if (isImpactEdge) {
            if (edge.source === focusedNodeId) {
                label = '→ downstream';
            } else if (edge.target === focusedNodeId) {
                label = '← upstream';
            }
        }

        const targetOpacity = isImpactEdge ? 1.0 : 0.15;
        const currentOpacity = edge.style?.opacity;
        const currentLabel = edge.label;

        // Skip cloning if state hasn't changed
        if (currentOpacity === targetOpacity && currentLabel === label) {
            return edge;
        }

        return {
            ...edge,
            label,
            style: {
                ...edge.style,
                strokeWidth: isImpactEdge ? 2.5 : 1,
                opacity: targetOpacity,
            },
        };
    });

    return { visibleNodes, visibleEdges };
}

/**
 * Calculate risk score for a node (0-1)
 */
function calculateNodeRisk(node: Node, thresholds: FilterContext['riskThresholds']): number {
    // For domain nodes
    if (node.type === 'domainNode') {
        const data = node.data as DomainNodeData;
        const health = data.health?.status;

        if (health === 'critical') return 1.0;
        if (health === 'warning') return 0.5;
        return 0.1;
    }

    // For symbol nodes
    if (node.type === 'symbolNode') {
        const data = node.data as SymbolNodeData;
        const complexity = data.complexity || 0;
        const coupling = data.coupling?.normalizedScore || 0;

        const complexityScore = complexity > thresholds.complexity ? 0.5 : 0;
        const couplingScore = coupling > thresholds.coupling ? 0.5 : 0;

        return Math.min(1.0, complexityScore + couplingScore);
    }

    return 0;
}

/**
 * Hook: Memoized graph filtering
 */
export function useFilteredGraph(
    allNodes: Node[],
    allEdges: Edge[],
    context: FilterContext
): FilteredGraph {
    return useMemo(() => {
        return applyViewMode(allNodes, allEdges, context);
    }, [allNodes, allEdges, context]);
}

/**
 * Get node visibility state
 */
export function getNodeVisibilityState(
    node: Node,
    context: FilterContext
): NodeVisibilityState {
    switch (context.mode) {
        case 'architecture':
            return {
                isVisible: node.type !== 'symbolNode',
                opacity: 1.0,
                isHighlighted: false,
            };

        case 'flow': {
            const isOnPath = context.executionFlows
                ? isNodeOnExecutionPath(node.id, context.executionFlows)
                : false;
            return {
                isVisible: true,
                opacity: isOnPath ? 1.0 : 0.15,
                isHighlighted: isOnPath,
            };
        }

        case 'risk': {
            const riskScore = calculateNodeRisk(node, context.riskThresholds);
            const isHighRisk = riskScore > 0.6;
            const isMediumRisk = riskScore > 0.3 && riskScore <= 0.6;

            return {
                isVisible: true,
                opacity: isHighRisk || isMediumRisk ? 1.0 : 0.3,
                isHighlighted: isHighRisk || isMediumRisk,
                glowColor: isHighRisk ? '#ef4444' : isMediumRisk ? '#f97316' : undefined,
            };
        }

        case 'impact': {
            const isFocused = node.id === context.focusedNodeId;
            const isRelated = context.relatedNodeIds.has(node.id);

            return {
                isVisible: true,
                opacity: isFocused || isRelated ? 1.0 : 0.15,
                isHighlighted: isFocused || isRelated,
            };
        }

        default:
            return {
                isVisible: true,
                opacity: 1.0,
                isHighlighted: false,
            };
    }
}
