import type { GraphData, GraphSymbol } from '../types';
import type { ExecutionFlow } from '../types/viewMode';
import { buildAdjacencyList } from './relationshipDetector';

/**
 * Flow Detection Engine
 * Detects entry points and traces execution paths to sinks
 */

// Entry point patterns
const ENTRY_POINT_PATTERNS = {
    api: /^(handle|handler|route|endpoint|api|controller)/i,
    main: /^(main|run|start|init|boot)/i,
    event: /^(on|handle|listener|subscribe)/i,
    route: /^(get|post|put|delete|patch|all|use)/i,
};

// Sink patterns (terminal operations)
const SINK_PATTERNS = {
    database: /(query|execute|find|save|update|delete|insert|select|transaction)/i,
    network: /(fetch|axios|request|get|post|http|https|send)/i,
    io: /(write|read|log|print|console|file|stream)/i,
    response: /(send|json|status|redirect|render)/i,
};

/**
 * Detect all execution flows in the graph
 */
export function detectExecutionFlows(graphData: GraphData): ExecutionFlow[] {
    const flows: ExecutionFlow[] = [];
    const { symbols, edges } = graphData;

    // Build adjacency list for traversal
    const edgeObjects = edges.map((e) => ({
        id: `${e.source}-${e.target}`,
        source: e.source,
        target: e.target,
    }));
    const { outgoing } = buildAdjacencyList(edgeObjects);

    // Find entry points
    const entryPoints = findEntryPoints(symbols);

    // For each entry point, trace to sinks
    entryPoints.forEach((entry) => {
        const sinks = tracePaths(entry.id, outgoing, symbols);

        if (sinks.length > 0) {
            flows.push({
                entryPoint: entry.id,
                sinks: sinks.map((s) => `${s.filePath}:${s.name}:${s.range.startLine}`),
                path: getFullPath(entry.id, sinks.map((s) => `${s.filePath}:${s.name}:${s.range.startLine}`), outgoing),
                type: entry.type,
            });
        }
    });

    return flows;
}

/**
 * Find entry point nodes in the graph
 */
function findEntryPoints(
    symbols: GraphSymbol[]
): Array<{ id: string; type: 'api' | 'main' | 'route' | 'event' }> {
    const entryPoints: Array<{ id: string; type: 'api' | 'main' | 'route' | 'event' }> = [];

    symbols.forEach((symbol) => {
        const symbolId = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
        const name = symbol.name;

        // Check against patterns
        if (ENTRY_POINT_PATTERNS.api.test(name)) {
            entryPoints.push({ id: symbolId, type: 'api' });
        } else if (ENTRY_POINT_PATTERNS.main.test(name)) {
            entryPoints.push({ id: symbolId, type: 'main' });
        } else if (ENTRY_POINT_PATTERNS.event.test(name)) {
            entryPoints.push({ id: symbolId, type: 'event' });
        } else if (ENTRY_POINT_PATTERNS.route.test(name)) {
            entryPoints.push({ id: symbolId, type: 'route' });
        }

        // Also check file paths for common entry point locations
        if (
            symbol.filePath.includes('/api/') ||
            symbol.filePath.includes('/routes/') ||
            symbol.filePath.includes('/handlers/') ||
            symbol.filePath.includes('/controllers/')
        ) {
            if (!entryPoints.some((e) => e.id === symbolId)) {
                entryPoints.push({ id: symbolId, type: 'api' });
            }
        }
    });

    return entryPoints;
}

/**
 * Find sink nodes (terminal operations)
 */
function findSinks(symbols: GraphSymbol[]): Set<string> {
    const sinks = new Set<string>();

    symbols.forEach((symbol) => {
        const symbolId = `${symbol.filePath}:${symbol.name}:${symbol.range.startLine}`;
        const name = symbol.name;

        // Check against sink patterns
        for (const pattern of Object.values(SINK_PATTERNS)) {
            if (pattern.test(name)) {
                sinks.add(symbolId);
                break;
            }
        }
    });

    return sinks;
}

/**
 * Trace paths from entry point to sinks using BFS
 */
function tracePaths(
    entryPointId: string,
    outgoing: Map<string, string[]>,
    symbols: GraphSymbol[]
): GraphSymbol[] {
    const sinkIds = findSinks(symbols);
    const foundSinks: GraphSymbol[] = [];
    const visited = new Set<string>();
    const queue: string[] = [entryPointId];

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current)) continue;
        visited.add(current);

        // Check if this is a sink
        if (sinkIds.has(current) && current !== entryPointId) {
            const symbol = symbols.find(
                (s) => `${s.filePath}:${s.name}:${s.range.startLine}` === current
            );
            if (symbol) {
                foundSinks.push(symbol);
            }
        }

        // Add neighbors to queue
        const neighbors = outgoing.get(current) || [];
        neighbors.forEach((neighbor) => {
            if (!visited.has(neighbor)) {
                queue.push(neighbor);
            }
        });
    }

    return foundSinks;
}

/**
 * Get complete path from entry to all sinks
 */
function getFullPath(
    entryPointId: string,
    sinkIds: string[],
    outgoing: Map<string, string[]>
): string[] {
    const pathNodes = new Set<string>([entryPointId]);
    const visited = new Set<string>();
    const queue: string[] = [entryPointId];

    while (queue.length > 0) {
        const current = queue.shift()!;

        if (visited.has(current)) continue;
        visited.add(current);

        const neighbors = outgoing.get(current) || [];
        neighbors.forEach((neighbor) => {
            if (!visited.has(neighbor)) {
                pathNodes.add(neighbor);
                queue.push(neighbor);

                // Stop expanding if we hit a sink
                if (!sinkIds.includes(neighbor)) {
                    // Continue traversing
                }
            }
        });
    }

    return Array.from(pathNodes);
}

/**
 * Check if a node is on any execution path
 */
export function isNodeOnExecutionPath(nodeId: string, flows: ExecutionFlow[]): boolean {
    return flows.some((flow) => flow.path.includes(nodeId));
}

/**
 * Get all flows that include a specific node
 */
export function getFlowsForNode(nodeId: string, flows: ExecutionFlow[]): ExecutionFlow[] {
    return flows.filter((flow) => flow.path.includes(nodeId));
}

/**
 * Calculate flow importance score (for edge weighting)
 */
export function calculateFlowImportance(
    sourceId: string,
    targetId: string,
    flows: ExecutionFlow[]
): number {
    let score = 0;

    flows.forEach((flow) => {
        const sourceIdx = flow.path.indexOf(sourceId);
        const targetIdx = flow.path.indexOf(targetId);

        if (sourceIdx !== -1 && targetIdx !== -1 && targetIdx === sourceIdx + 1) {
            // This edge is on a direct flow path
            score += 1;

            // Bonus for critical paths (API -> DB)
            if (flow.type === 'api') {
                score += 0.5;
            }
        }
    });

    return Math.min(score, 3); // Cap at 3
}
