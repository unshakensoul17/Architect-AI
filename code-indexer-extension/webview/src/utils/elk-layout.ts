import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

import type { ViewMode } from '../types/viewMode';

const elk = new ELK();

export interface ElkLayoutOptions {
    direction?: 'DOWN' | 'RIGHT' | ' UP' | 'LEFT';
    nodeSpacing?: number;
    layerSpacing?: number;
    viewMode?: ViewMode;
}

/**
 * Apply ELK layout to nodes and edges
 */
export async function applyElkLayout(
    nodes: Node[],
    edges: Edge[],
    options: ElkLayoutOptions = {}
): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const {
        direction = 'DOWN',
        nodeSpacing = 100,
        layerSpacing = 150,
    } = options;

    // Build a map of nodes by ID to quickly find them during edge processing and layout mapping
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // Map of ELK nodes to build the hierarchy
    const elkNodeMap = new Map<string, ElkNode>();

    // 1. Create ELK nodes for every React Flow node
    nodes.forEach(node => {
        // Default sizes based on node type
        let width = 180;
        let height = 60;

        if (node.type === 'domainNode') {
            width = 500;
            height = 300;
        } else if (node.type === 'fileNode') {
            width = 300;
            height = 150;
        }

        const elkNode: ElkNode = {
            id: node.id,
            width,
            height,
            children: [],
        };

        // Add layout options based on type
        if (node.type === 'domainNode') {
            elkNode.layoutOptions = {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.padding': '[top=220,left=50,bottom=50,right=50]',
                'elk.spacing.nodeNode': '60',
                'elk.layered.spacing.nodeNodeBetweenLayers': '100',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.aspectRatio': '2.4',
                'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            };
        } else if (node.type === 'fileNode') {
            elkNode.layoutOptions = {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.padding': '[top=110,left=20,bottom=20,right=20]',
                'elk.spacing.nodeNode': '20',
                'elk.layered.spacing.nodeNodeBetweenLayers': '40',
                'elk.edgeRouting': 'SPLINES',
            };
        }

        elkNodeMap.set(node.id, elkNode);
    });

    // 2. Build the hierarchy based on parentId
    const rootChildren: ElkNode[] = [];
    nodes.forEach(node => {
        const elkNode = elkNodeMap.get(node.id)!;
        if (node.parentId && elkNodeMap.has(node.parentId)) {
            elkNodeMap.get(node.parentId)!.children!.push(elkNode);
        } else {
            rootChildren.push(elkNode);
        }
    });

    // Create ELK graph structure
    const elkGraph: ElkNode = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': direction,
            'elk.spacing.nodeNode': nodeSpacing.toString(),
            'elk.spacing.edgeNode': '40',
            'elk.layered.spacing.nodeNodeBetweenLayers': layerSpacing.toString(),
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.padding': '[top=100,left=100,bottom=100,right=100]',
            'elk.edgeRouting': 'SPLINES',
            'elk.layered.mergeEdges': 'true',
            'elk.separateConnectedComponents': 'true',
            'elk.spacing.componentComponent': '140',
            'elk.aspectRatio': '1.6',
            'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
        },
        children: rootChildren,
        edges: edges.map((edge) => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        })),
    };

    // Calculate layout
    const layoutedGraph = await elk.layout(elkGraph);

    // 3. Map positions back to React Flow nodes (flat list)
    const layoutedNodes: Node[] = [];

    // Recursive function to traverse ELK graph and build layouted React Flow nodes
    const mapNodes = (elkNodes: ElkNode[]) => {
        elkNodes.forEach((elkNode) => {
            const originalNode = nodeMap.get(elkNode.id);
            if (originalNode) {
                layoutedNodes.push({
                    ...originalNode,
                    position: {
                        x: elkNode.x ?? 0,
                        y: elkNode.y ?? 0,
                    },
                    style: {
                        ...originalNode.style,
                        width: elkNode.width,
                        height: elkNode.height,
                    },
                });
            }

            if (elkNode.children && elkNode.children.length > 0) {
                mapNodes(elkNode.children);
            }
        });
    };

    if (layoutedGraph.children) {
        mapNodes(layoutedGraph.children);
    }

    return { nodes: layoutedNodes, edges };
}

/**
 * Clear layout cache
 */
export function clearLayoutCache(): void {
    // No-op for now since we removed caching
}
