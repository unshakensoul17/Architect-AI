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

    // Helper to check if a node is a nested folder (has a parent that is also a domain)
    const isNestedFolder = (node: Node) => {
        if (node.type !== 'domainNode') return false;
        if (!node.parentId) return false;
        const parent = nodeMap.get(node.parentId);
        return parent && parent.type === 'domainNode';
    };

    nodes.forEach(node => {
        // Hierarchy Sizes (1.4x Scaling):
        // 1. Root Domain (Largest): Holds everything
        // 2. Folder / Sub-domain (Medium): Holds files
        // 3. File (Small): Leaf node

        let width = 200;
        let height = 60;

        if (node.type === 'domainNode') {
            if (isNestedFolder(node)) {
                // Folder (Medium)
                width = 400; // Was 560, Orig 280
                height = 250; // Was 360, Orig 180
            } else {
                // Root Domain (Largest)
                width = 600; // Was 800, Orig 400
                height = 380; // Was 500, Orig 250
            }
        } else if (node.type === 'fileNode') {
            // File (Small)
            width = 280; // Was 400, Orig 200
            height = 120; // Was 180, Orig 90
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
                // Stitched Look: Top padding matches header
                'elk.padding': '[top=50,left=20,bottom=20,right=20]',
                'elk.spacing.nodeNode': '30', // Tuned
                'elk.layered.spacing.nodeNodeBetweenLayers': '40',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
                'elk.aspectRatio': '2.0',
                'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
            };
        } else if (node.type === 'fileNode') {
            elkNode.layoutOptions = {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.padding': '[top=40,left=15,bottom=15,right=15]',
                'elk.spacing.nodeNode': '15',
                'elk.layered.spacing.nodeNodeBetweenLayers': '25',
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
            'elk.spacing.nodeNode': '60', // Tuned global spacing
            'elk.spacing.edgeNode': '30',
            'elk.layered.spacing.nodeNodeBetweenLayers': '80',
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.padding': '[top=80,left=80,bottom=80,right=80]',
            'elk.edgeRouting': 'SPLINES',
            'elk.layered.mergeEdges': 'true',
            'elk.separateConnectedComponents': 'true',
            'elk.spacing.componentComponent': '100',
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
