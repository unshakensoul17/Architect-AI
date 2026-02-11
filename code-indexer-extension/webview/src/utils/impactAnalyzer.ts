import type { Node, Edge } from '@xyflow/react';
import type { ImpactAnalysis, ImpactStats } from '../types/viewMode';
import { buildAdjacencyList } from './relationshipDetector';

/**
 * Impact Analyzer
 * Computes blast radius for change impact analysis
 */

/**
 * Analyze the impact of changing a node
 * Computes upstream (who depends on this) and downstream (what this depends on)
 */
export function analyzeImpact(
    nodeId: string,
    nodes: Node[],
    edges: Edge[]
): ImpactAnalysis {
    const { incoming, outgoing } = buildAdjacencyList(edges);

    // Compute upstream dependencies (who calls this)
    const upstream = computeUpstreamDeps(nodeId, incoming);

    // Compute downstream dependencies (what this calls)
    const downstream = computeDownstreamDeps(nodeId, outgoing);

    // Index nodes by ID for O(1) lookup
    const nodeMap = new Map(nodes.map(n => [n.id, n]));

    // Count affected files and domains
    const affectedFiles = new Set<string>();
    const affectedDomains = new Set<string>();

    const allAffected = new Set([...upstream, ...downstream, nodeId]);
    allAffected.forEach((id) => {
        const node = nodeMap.get(id);
        if (node) {
            // Get file path
            const filePath = (node.data as any)?.filePath || node.parentId;
            if (filePath) {
                affectedFiles.add(filePath);
            }

            // Get domain
            const domain = extractDomain(id, node);
            if (domain) {
                affectedDomains.add(domain);
            }
        }
    });

    const stats: ImpactStats = {
        affectedFunctions: allAffected.size - 1, // Exclude the node itself
        affectedFiles: affectedFiles.size,
        affectedDomains: affectedDomains.size,
        upstreamDeps: upstream,
        downstreamDeps: downstream,
    };

    return {
        nodeId,
        upstream,
        downstream,
        affectedFiles,
        affectedDomains,
        stats,
    };
}

/**
 * Compute all upstream dependencies (BFS)
 * Returns nodes that call this node (directly or indirectly)
 */
function computeUpstreamDeps(
    nodeId: string,
    incoming: Map<string, string[]>
): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current)) continue;
        visited.add(current);

        const callers = incoming.get(current) || [];
        callers.forEach((caller) => {
            if (!visited.has(caller)) {
                result.push(caller);
                queue.push(caller);
            }
        });
    }

    return result;
}

/**
 * Compute all downstream dependencies (BFS)
 * Returns nodes that this node calls (directly or indirectly)
 */
function computeDownstreamDeps(
    nodeId: string,
    outgoing: Map<string, string[]>
): string[] {
    const result: string[] = [];
    const visited = new Set<string>();
    const queue: string[] = [nodeId];

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current)) continue;
        visited.add(current);

        const callees = outgoing.get(current) || [];
        callees.forEach((callee) => {
            if (!visited.has(callee)) {
                result.push(callee);
                queue.push(callee);
            }
        });
    }

    return result;
}

/**
 * Extract domain from node ID or node data
 */
function extractDomain(nodeId: string, node: Node): string | null {
    // If it's a domain node
    if (node.type === 'domainNode') {
        return nodeId;
    }

    // If it has a parent domain
    if (node.parentId?.startsWith('domain:')) {
        return node.parentId;
    }

    // Try to extract from node ID (domain:xxx format)
    if (nodeId.startsWith('domain:')) {
        return nodeId;
    }

    // Try to get from data
    const domain = (node.data as any)?.domain;
    if (domain) {
        return `domain:${domain}`;
    }

    return null;
}

/**
 * Calculate impact severity score (0-100)
 * Higher score = more severe impact
 */
export function calculateImpactSeverity(stats: ImpactStats, nodeData?: any): number {
    const functionWeight = 1;
    const fileWeight = 5;
    const domainWeight = 20;

    // Use AI-inferred impact depth if available (1-10)
    const aiImpactDepth = nodeData?.impactDepth || 1;
    const depthMultiplier = aiImpactDepth / 5; // e.g., 10 -> 2x multiplier, 5 -> 1x

    let score =
        stats.affectedFunctions * functionWeight +
        stats.affectedFiles * fileWeight +
        stats.affectedDomains * domainWeight;

    score *= depthMultiplier;

    // Normalize to 0-100
    return Math.min(100, (score / 100) * 100);
}

/**
 * Get impact severity level
 */
export function getImpactSeverityLevel(
    severity: number
): 'low' | 'medium' | 'high' | 'critical' {
    if (severity >= 75) return 'critical';
    if (severity >= 50) return 'high';
    if (severity >= 25) return 'medium';
    return 'low';
}

/**
 * Batch analyze impact for multiple nodes
 * Useful for analyzing entire modules or files
 */
export function batchAnalyzeImpact(
    nodeIds: string[],
    nodes: Node[],
    edges: Edge[]
): Map<string, ImpactAnalysis> {
    const results = new Map<string, ImpactAnalysis>();

    nodeIds.forEach((nodeId) => {
        const analysis = analyzeImpact(nodeId, nodes, edges);
        results.set(nodeId, analysis);
    });

    return results;
}
