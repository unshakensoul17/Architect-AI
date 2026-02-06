import ELK, { type ElkNode } from 'elkjs/lib/elk.bundled.js';
import type { Node, Edge } from '@xyflow/react';

const elk = new ELK();

export interface ElkLayoutOptions {
    direction?: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
    nodeSpacing?: number;
    layerSpacing?: number;
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
        nodeSpacing = 50,
        layerSpacing = 100,
    } = options;

    // Separate nodes by type
    const domainNodes = nodes.filter((n) => n.type === 'domainNode');
    const fileNodes = nodes.filter((n) => n.type === 'fileNode');
    const symbolNodes = nodes.filter((n) => n.type === 'symbolNode');

    // Create ELK graph structure with 3-level hierarchy
    const elkGraph: ElkNode = {
        id: 'root',
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': direction,
            'elk.spacing.nodeNode': nodeSpacing.toString(),
            'elk.spacing.edgeNode': '20',
            'elk.layered.spacing.nodeNodeBetweenLayers': layerSpacing.toString(),
            'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            'elk.padding': '[top=50,left=20,bottom=20,right=20]',
        },
        children: domainNodes.map((domainNode) => ({
            id: domainNode.id,
            width: 500, // Larger minimum width for domain
            height: 300, // Larger minimum height for domain
            layoutOptions: {
                'elk.algorithm': 'layered',
                'elk.direction': 'DOWN',
                'elk.padding': '[top=100,left=30,bottom=30,right=30]', // More padding for domain header
                'elk.spacing.nodeNode': '40',
                'elk.layered.spacing.nodeNodeBetweenLayers': '80',
                'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
            },
            // Files as children of domains
            children: fileNodes
                .filter((f) => f.parentId === domainNode.id)
                .map((fileNode) => ({
                    id: fileNode.id,
                    width: 300,
                    height: 150,
                    layoutOptions: {
                        'elk.algorithm': 'layered',
                        'elk.direction': 'DOWN',
                        'elk.padding': '[top=60,left=20,bottom=20,right=20]',
                        'elk.spacing.nodeNode': '30',
                        'elk.layered.spacing.nodeNodeBetweenLayers': '60',
                    },
                    // Symbols as children of files
                    children: symbolNodes
                        .filter(
                            (s) =>
                                s.parentId === fileNode.id ||
                                (s.data as any).filePath === fileNode.id
                        )
                        .map((symbolNode) => ({
                            id: symbolNode.id,
                            width: 180,
                            height: 60,
                        })),
                })),
        })),
        edges: edges.map((edge) => ({
            id: edge.id,
            sources: [edge.source],
            targets: [edge.target],
        })),
    };

    // Calculate layout
    const layoutedGraph = await elk.layout(elkGraph);

    // Map positions back to React Flow nodes
    const layoutedNodes: Node[] = [];

    // Process domain nodes (top level)
    layoutedGraph.children?.forEach((domainElkNode) => {
        const originalDomainNode = domainNodes.find((n) => n.id === domainElkNode.id);
        if (originalDomainNode) {
            layoutedNodes.push({
                ...originalDomainNode,
                position: {
                    x: domainElkNode.x ?? 0,
                    y: domainElkNode.y ?? 0,
                },
                style: {
                    ...originalDomainNode.style,
                    width: domainElkNode.width,
                    height: domainElkNode.height,
                },
            });
        }

        // Process file nodes (children of domains)
        domainElkNode.children?.forEach((fileElkNode) => {
            const originalFileNode = fileNodes.find((n) => n.id === fileElkNode.id);
            if (originalFileNode) {
                layoutedNodes.push({
                    ...originalFileNode,
                    position: {
                        x: fileElkNode.x ?? 0,
                        y: fileElkNode.y ?? 0,
                    },
                    style: {
                        ...originalFileNode.style,
                        width: fileElkNode.width,
                        height: fileElkNode.height,
                    },
                });
            }

            // Process symbol nodes (children of files)
            fileElkNode.children?.forEach((symbolElkNode) => {
                const originalSymbolNode = symbolNodes.find(
                    (n) => n.id === symbolElkNode.id
                );
                if (originalSymbolNode) {
                    layoutedNodes.push({
                        ...originalSymbolNode,
                        position: {
                            x: symbolElkNode.x ?? 0,
                            y: symbolElkNode.y ?? 0,
                        },
                    });
                }
            });
        });
    });

    return { nodes: layoutedNodes, edges };
}
