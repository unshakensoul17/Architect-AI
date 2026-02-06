// Purpose: Typed message protocol for worker communication
// Ensures strict contracts between extension host and worker thread
// Prevents malformed requests and simplifies debugging

import { GraphExport } from '../db/database';

/**
 * Messages sent from extension host to worker
 */
export type WorkerRequest =
    | {
        type: 'parse';
        id: string;
        filePath: string;
        content: string;
        language: 'typescript' | 'python' | 'c';
    }
    | {
        type: 'parse-batch';
        id: string;
        files: { filePath: string; content: string; language: 'typescript' | 'python' | 'c' }[];
    }
    | {
        type: 'query-symbols';
        id: string;
        query: string;
    }
    | {
        type: 'query-file';
        id: string;
        filePath: string;
    }
    | {
        type: 'check-file-hash';
        id: string;
        filePath: string;
        content: string;
    }
    | {
        type: 'export-graph';
        id: string;
    }
    | {
        type: 'clear';
        id: string;
    }
    | {
        type: 'stats';
        id: string;
    }
    | {
        type: 'shutdown';
        id: string;
    };

/**
 * Messages sent from worker to extension host
 */
export type WorkerResponse =
    | {
        type: 'parse-complete';
        id: string;
        symbolCount: number;
        edgeCount: number;
    }
    | {
        type: 'parse-batch-complete';
        id: string;
        totalSymbols: number;
        totalEdges: number;
        filesProcessed: number;
    }
    | {
        type: 'query-result';
        id: string;
        symbols: SymbolResult[];
    }
    | {
        type: 'file-hash-result';
        id: string;
        needsReindex: boolean;
        storedHash: string | null;
        currentHash: string;
    }
    | {
        type: 'graph-export';
        id: string;
        graph: GraphExport;
    }
    | {
        type: 'stats-result';
        id: string;
        stats: IndexStats;
    }
    | {
        type: 'clear-complete';
        id: string;
    }
    | {
        type: 'error';
        id: string;
        error: string;
        stack?: string;
    }
    | {
        type: 'ready';
    };

/**
 * Symbol result structure
 */
export interface SymbolResult {
    id: number;
    name: string;
    type: string;
    filePath: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
    complexity: number;
}

/**
 * Index statistics
 */
export interface IndexStats {
    symbolCount: number;
    edgeCount: number;
    fileCount: number;
    lastIndexTime?: string;
}

/**
 * Type guard to check if message is a WorkerRequest
 */
export function isWorkerRequest(msg: unknown): msg is WorkerRequest {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        'id' in msg &&
        typeof (msg as any).type === 'string'
    );
}

/**
 * Type guard to check if message is a WorkerResponse
 */
export function isWorkerResponse(msg: unknown): msg is WorkerResponse {
    return (
        typeof msg === 'object' &&
        msg !== null &&
        'type' in msg &&
        typeof (msg as any).type === 'string'
    );
}
