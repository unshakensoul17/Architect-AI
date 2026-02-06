// Purpose: Background worker for CPU-intensive tasks
// ALL parsing and database operations happen here
// Prevents VS Code UI freezing

import { parentPort } from 'worker_threads';
import { CodeIndexDatabase } from '../db/database';
import { TreeSitterParser } from './parser';
import { SymbolExtractor } from './symbol-extractor';
import {
    WorkerRequest,
    WorkerResponse,
    isWorkerRequest,
    SymbolResult,
} from './message-protocol';
import * as path from 'path';
import * as os from 'os';

class IndexWorker {
    private db: CodeIndexDatabase | null = null;
    private parser: TreeSitterParser;
    private extractor: SymbolExtractor;
    private isReady: boolean = false;

    constructor() {
        this.parser = new TreeSitterParser();
        this.extractor = new SymbolExtractor();
    }

    /**
     * Initialize worker resources
     */
    async initialize(): Promise<void> {
        try {
            // Initialize database in temp directory
            const dbPath = path.join(os.tmpdir(), 'code-indexer', 'index.db');
            this.db = new CodeIndexDatabase(dbPath);

            // Initialize tree-sitter parser
            await this.parser.initialize();

            this.isReady = true;

            // Send ready signal
            this.sendMessage({
                type: 'ready',
            });
        } catch (error) {
            console.error('Worker initialization failed:', error);
            throw error;
        }
    }

    /**
     * Handle incoming messages
     */
    handleMessage(request: WorkerRequest): void {
        if (!this.isReady) {
            this.sendError(request.id, 'Worker not initialized');
            return;
        }

        try {
            switch (request.type) {
                case 'parse':
                    this.handleParse(request.id, request.filePath, request.content, request.language);
                    break;

                case 'query-symbols':
                    this.handleQuerySymbols(request.id, request.query);
                    break;

                case 'query-file':
                    this.handleQueryFile(request.id, request.filePath);
                    break;

                case 'clear':
                    this.handleClear(request.id);
                    break;

                case 'stats':
                    this.handleStats(request.id);
                    break;

                case 'shutdown':
                    this.handleShutdown();
                    break;

                default:
                    this.sendError(request.id, `Unknown request type: ${(request as any).type}`);
            }
        } catch (error) {
            this.sendError(
                request.id,
                error instanceof Error ? error.message : String(error),
                error instanceof Error ? error.stack : undefined
            );
        }
    }

    /**
     * Parse file and store symbols
     */
    private handleParse(
        id: string,
        filePath: string,
        content: string,
        language: 'typescript' | 'python' | 'c'
    ): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        // Parse AST
        const tree = this.parser.parse(content, language);

        // Extract symbols and edges
        const { symbols, edges } = this.extractor.extract(tree, filePath, language);

        // Delete existing symbols for this file (incremental update)
        this.db.deleteSymbolsByFile(filePath);

        // Insert new symbols and edges in transaction
        const symbolIds = this.db.insertSymbols(symbols);

        // Map local symbol indices to database IDs for edge creation
        const edgesWithIds = edges.map((edge) => ({
            sourceId: symbolIds[edge.sourceId] || 0,
            targetId: symbolIds[edge.targetId] || 0,
            type: edge.type,
        }));

        this.db.insertEdges(edgesWithIds);

        // Update last index time
        this.db.setMeta('last_index_time', new Date().toISOString());

        // Send completion response
        this.sendMessage({
            type: 'parse-complete',
            id,
            symbolCount: symbols.length,
            edgeCount: edges.length,
        });
    }

    /**
     * Query symbols by name
     */
    private handleQuerySymbols(id: string, query: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const symbols = this.db.getSymbolsByName(query);
        const results: SymbolResult[] = symbols.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            filePath: s.filePath,
            range: {
                startLine: s.rangeStartLine,
                startColumn: s.rangeStartColumn,
                endLine: s.rangeEndLine,
                endColumn: s.rangeEndColumn,
            },
            complexity: s.complexity,
        }));

        this.sendMessage({
            type: 'query-result',
            id,
            symbols: results,
        });
    }

    /**
     * Query symbols by file
     */
    private handleQueryFile(id: string, filePath: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const symbols = this.db.getSymbolsByFile(filePath);
        const results: SymbolResult[] = symbols.map((s) => ({
            id: s.id,
            name: s.name,
            type: s.type,
            filePath: s.filePath,
            range: {
                startLine: s.rangeStartLine,
                startColumn: s.rangeStartColumn,
                endLine: s.rangeEndLine,
                endColumn: s.rangeEndColumn,
            },
            complexity: s.complexity,
        }));

        this.sendMessage({
            type: 'query-result',
            id,
            symbols: results,
        });
    }

    /**
     * Clear entire index
     */
    private handleClear(id: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        this.db.clearIndex();

        this.sendMessage({
            type: 'clear-complete',
            id,
        });
    }

    /**
     * Get index statistics
     */
    private handleStats(id: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const stats = this.db.getStats();
        const lastIndexTime = this.db.getMeta('last_index_time');

        this.sendMessage({
            type: 'stats-result',
            id,
            stats: {
                ...stats,
                lastIndexTime: lastIndexTime || undefined,
            },
        });
    }

    /**
     * Shutdown worker
     */
    private handleShutdown(): void {
        if (this.db) {
            this.db.close();
        }
        process.exit(0);
    }

    /**
     * Send message to parent thread
     */
    private sendMessage(message: WorkerResponse): void {
        if (parentPort) {
            parentPort.postMessage(message);
        }
    }

    /**
     * Send error message
     */
    private sendError(id: string, error: string, stack?: string): void {
        this.sendMessage({
            type: 'error',
            id,
            error,
            stack,
        });
    }
}

// Initialize worker
const worker = new IndexWorker();

worker.initialize().catch((error) => {
    console.error('Fatal worker initialization error:', error);
    process.exit(1);
});

// Listen for messages from parent
if (parentPort) {
    parentPort.on('message', (message: unknown) => {
        if (isWorkerRequest(message)) {
            worker.handleMessage(message);
        } else {
            console.error('Invalid message received:', message);
        }
    });
}
