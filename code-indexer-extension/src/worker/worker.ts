// Purpose: Background worker for CPU-intensive tasks
// ALL parsing and database operations happen here
// Prevents VS Code UI freezing

import { parentPort } from 'worker_threads';
import { CodeIndexDatabase } from '../db/database';
import { TreeSitterParser } from './parser';
import { SymbolExtractor, ImportInfo, CallInfo } from './symbol-extractor';
import {
    WorkerRequest,
    WorkerResponse,
    isWorkerRequest,
    SymbolResult,
} from './message-protocol';
import { AIOrchestrator, createOrchestrator } from '../ai';
import { InspectorService } from './inspector-service';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

class IndexWorker {
    private db: CodeIndexDatabase | null = null;
    private parser: TreeSitterParser;
    private extractor: SymbolExtractor;
    private isReady: boolean = false;
    private orchestrator: AIOrchestrator | null = null;
    private inspector: InspectorService | null = null;

    // Global symbol map for cross-file resolution
    private globalSymbolMap: Map<string, number> = new Map();

    // Pending imports and calls for edge resolution
    private allImports: ImportInfo[] = [];
    private allCalls: CallInfo[] = [];

    constructor() {
        this.parser = new TreeSitterParser();
        this.extractor = new SymbolExtractor();
    }

    /**
     * Initialize worker resources
     */
    async initialize(): Promise<void> {
        try {
            // Start memory monitoring
            this.startMemoryMonitor();

            // Initialize database in temp directory
            const dbPath = path.join(os.tmpdir(), 'code-indexer', 'index.db');
            this.db = new CodeIndexDatabase(dbPath);

            // Initialize tree-sitter parser
            await this.parser.initialize();

            // Initialize AI Orchestrator
            this.orchestrator = createOrchestrator(this.db);

            // Initialize Inspector Service
            this.inspector = new InspectorService(this.db, this.orchestrator);

            this.isReady = true;
            console.log('Worker: ready signal sent');

            // Send ready signal
            this.sendMessage({
                type: 'ready',
            });
        } catch (error) {
            console.error('Worker initialization failed:', error);
            if (error instanceof Error) {
                console.error('Stack:', error.stack);
            }
            throw error;
        }
    }

    /**
     * Start periodic memory monitoring
     */
    private startMemoryMonitor(): void {
        setInterval(() => {
            this.checkMemoryUsage();
        }, 5000); // Check every 5 seconds
    }

    /**
     * Check memory usage and exit if limit exceeded
     */
    private checkMemoryUsage(): void {
        const usage = process.memoryUsage();
        const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);

        // 512MB limit
        if (heapUsedMB > 512) {
            const error = `Memory limit exceeded: ${heapUsedMB}MB (limit: 512MB)`;
            console.error(error);
            // Send explicit error message before exiting to ensure manager knows why
            this.sendMessage({
                type: 'error',
                id: 'system',
                error: error,
            });
            // Allow time for message to flush
            setTimeout(() => {
                process.exit(137); // Standard OOM exit code
            }, 100);
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

                case 'parse-batch':
                    this.handleParseBatch(request.id, request.files);
                    break;

                case 'query-symbols':
                    this.handleQuerySymbols(request.id, request.query);
                    break;

                case 'query-file':
                    this.handleQueryFile(request.id, request.filePath);
                    break;

                case 'check-file-hash':
                    this.handleCheckFileHash(request.id, request.filePath, request.content);
                    break;

                case 'export-graph':
                    this.handleExportGraph(request.id);
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

                case 'ai-query':
                    this.handleAIQuery(request);
                    break;

                case 'ai-classify-intent':
                    this.handleAIClassifyIntent(request);
                    break;

                case 'mcp-tool-call':
                    this.handleMCPToolCall(request);
                    break;

                case 'get-context':
                    this.handleGetContext(request);
                    break;

                case 'configure-ai':
                    this.handleConfigureAI(request);
                    break;

                // Inspector Panel Handlers
                case 'inspector-overview':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.getOverview(request.nodeId, request.nodeType)
                        .then(data => this.sendMessage({
                            type: 'inspector-overview-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-dependencies':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.getDependencies(request.nodeId, request.nodeType)
                        .then(data => this.sendMessage({
                            type: 'inspector-dependencies-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-risks':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.getRisks(request.nodeId, request.nodeType)
                        .then(data => this.sendMessage({
                            type: 'inspector-risks-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-ai-action':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.executeAIAction(request.nodeId, request.action)
                        .then(data => this.sendMessage({
                            type: 'inspector-ai-result',
                            id: request.id,
                            requestId: request.requestId,
                            data
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'inspector-ai-why':
                    if (!this.inspector) {
                        this.sendError(request.id, 'Inspector service not initialized');
                        return;
                    }
                    this.inspector.explainRisk(request.nodeId, request.metric)
                        .then(content => this.sendMessage({
                            type: 'inspector-ai-why-result',
                            id: request.id,
                            requestId: request.requestId,
                            content,
                            model: 'groq'
                        }))
                        .catch(err => this.sendError(request.id, err.message));
                    break;

                case 'refine-graph':
                    this.handleRefineGraph(request.id);
                    break;

                default:
                    this.sendError((request as any).id, `Unknown request type: ${(request as any).type}`);
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

        // Extract symbols, imports, and calls
        const { symbols, imports, calls } = this.extractor.extract(tree, filePath, language);

        // Delete existing symbols for this file (incremental update)
        this.db.deleteSymbolsByFile(filePath);

        // Insert new symbols and get their IDs
        const symbolIds = this.db.insertSymbols(symbols);

        // Build local symbol map for this file
        const localSymbolMap = this.extractor.getSymbolIdMap();

        // Update global symbol map with database IDs
        let i = 0;
        for (const [key] of localSymbolMap) {
            if (symbolIds[i]) {
                this.globalSymbolMap.set(key, symbolIds[i]);
            }
            i++;
        }

        // Store imports and calls for later edge resolution
        this.allImports.push(...imports);
        this.allCalls.push(...calls);

        // Create call edges within the same file
        const callEdges = this.extractor.createCallEdges(calls, this.globalSymbolMap);

        // Create import edges
        const importEdges = this.extractor.createImportEdges(imports, this.globalSymbolMap);

        // Combine all edges
        const allEdges = [...callEdges, ...importEdges];

        this.db.insertEdges(allEdges);

        // Update file hash for incremental indexing
        const contentHash = CodeIndexDatabase.computeHash(content);
        this.db.setFileHash(filePath, contentHash);

        // Update last index time
        this.db.setMeta('last_index_time', new Date().toISOString());

        // Send completion response
        this.sendMessage({
            type: 'parse-complete',
            id,
            symbolCount: symbols.length,
            edgeCount: allEdges.length,
        });
    }

    /**
     * Parse multiple files in batch for better cross-file edge resolution
     */
    private handleParseBatch(
        id: string,
        files: { filePath: string; content: string; language: 'typescript' | 'python' | 'c' }[]
    ): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        let totalSymbols = 0;
        const allImports: ImportInfo[] = [];
        const allCalls: CallInfo[] = [];
        const fileSymbolMaps: Map<string, Map<string, number>> = new Map();

        // First pass: extract all symbols
        for (const file of files) {
            const tree = this.parser.parse(file.content, file.language);
            const { symbols, imports, calls } = this.extractor.extract(tree, file.filePath, file.language);

            // Delete existing symbols for this file
            this.db.deleteSymbolsByFile(file.filePath);

            // Insert symbols and get IDs
            const symbolIds = this.db.insertSymbols(symbols);
            totalSymbols += symbols.length;

            // Build symbol map for this file
            const localSymbolMap = this.extractor.getSymbolIdMap();
            let i = 0;
            for (const [key] of localSymbolMap) {
                if (symbolIds[i]) {
                    this.globalSymbolMap.set(key, symbolIds[i]);
                }
                i++;
            }
            fileSymbolMaps.set(file.filePath, localSymbolMap);

            // Collect imports and calls
            allImports.push(...imports);
            allCalls.push(...calls);

            // Update file hash
            const contentHash = CodeIndexDatabase.computeHash(file.content);
            this.db.setFileHash(file.filePath, contentHash);
        }

        // Second pass: create edges with full symbol knowledge
        const callEdges = this.extractor.createCallEdges(allCalls, this.globalSymbolMap);
        const importEdges = this.extractor.createImportEdges(allImports, this.globalSymbolMap);
        const allEdges = [...callEdges, ...importEdges];

        this.db.insertEdges(allEdges);

        // Update last index time
        this.db.setMeta('last_index_time', new Date().toISOString());

        this.sendMessage({
            type: 'parse-batch-complete',
            id,
            totalSymbols,
            totalEdges: allEdges.length,
            filesProcessed: files.length,
        });
    }

    /**
     * Check if file needs re-indexing based on content hash
     */
    private handleCheckFileHash(id: string, filePath: string, content: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const storedHash = this.db.getFileHash(filePath);
        const currentHash = CodeIndexDatabase.computeHash(content);
        const needsReindex = storedHash !== currentHash;

        this.sendMessage({
            type: 'file-hash-result',
            id,
            needsReindex,
            storedHash,
            currentHash,
        });
    }

    /**
     * Export entire graph as JSON
     */
    private handleExportGraph(id: string): void {
        if (!this.db) {
            this.sendError(id, 'Database not initialized');
            return;
        }

        const graph = this.db.exportGraph();
        console.log(`Worker: exported graph with ${graph.symbols.length} symbols, ${graph.edges.length} edges`);

        this.sendMessage({
            type: 'graph-export',
            id,
            graph,
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
        this.globalSymbolMap.clear();
        this.allImports = [];
        this.allCalls = [];

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
     * Handle AI Query
     */
    private async handleAIQuery(request: any): Promise<void> {
        if (!this.orchestrator) {
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        try {
            const result = await this.orchestrator.processQuery(request.query, {
                symbolId: request.symbolId,
                symbolName: request.symbolName,
                analysisType: request.analysisType,
            });

            this.sendMessage({
                type: 'ai-query-result',
                id: request.id,
                content: result.content,
                model: result.model,
                intent: {
                    type: result.intent.type,
                    confidence: result.intent.confidence,
                },
                latencyMs: result.latencyMs,
                contextIncluded: result.contextIncluded,
                neighborCount: result.neighborCount,
            });
        } catch (error) {
            this.sendError(request.id, `AI Query failed: ${(error as Error).message}`);
        }
    }

    /**
     * Handle AI Intent Classification
     */
    private handleAIClassifyIntent(request: any): void {
        if (!this.orchestrator) {
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        const intent = this.orchestrator.classifyIntent(request.query);

        this.sendMessage({
            type: 'ai-intent-result',
            id: request.id,
            intentType: intent.type,
            confidence: intent.confidence,
            matchedPattern: intent.matchedPattern,
        });
    }

    /**
     * Handle MCP Tool Call
     */
    private async handleMCPToolCall(request: any): Promise<void> {
        if (!this.orchestrator) {
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        const response = await this.orchestrator.executeMCPTool({
            toolName: request.toolName,
            arguments: request.arguments,
        });

        this.sendMessage({
            type: 'mcp-tool-result',
            id: request.id,
            success: response.success,
            toolName: response.toolName,
            result: response.result,
            error: response.error,
        });
    }

    /**
     * Handle Get Context
     */
    private handleGetContext(request: any): void {
        if (!this.db) {
            this.sendError(request.id, 'Database not initialized');
            return;
        }

        const context = this.db.getSymbolWithContext(request.symbolId);

        if (!context) {
            this.sendMessage({
                type: 'context-result',
                id: request.id,
                symbol: null,
                neighbors: [],
                incomingEdgeCount: 0,
                outgoingEdgeCount: 0,
            });
            return;
        }

        this.sendMessage({
            type: 'context-result',
            id: request.id,
            symbol: {
                id: context.symbol.id,
                name: context.symbol.name,
                type: context.symbol.type,
                filePath: context.symbol.filePath,
                range: {
                    startLine: context.symbol.rangeStartLine,
                    startColumn: context.symbol.rangeStartColumn,
                    endLine: context.symbol.rangeEndLine,
                    endColumn: context.symbol.rangeEndColumn,
                },
                complexity: context.symbol.complexity,
            },
            neighbors: context.neighbors.map(n => ({
                id: n.id,
                name: n.name,
                type: n.type,
                filePath: n.filePath,
                range: {
                    startLine: n.rangeStartLine,
                    startColumn: n.rangeStartColumn,
                    endLine: n.rangeEndLine,
                    endColumn: n.rangeEndColumn,
                },
                complexity: n.complexity,
            })),
            incomingEdgeCount: context.incomingEdges.length,
            outgoingEdgeCount: context.outgoingEdges.length,
        });
    }

    /**
     * Handle AI Configuration
     */
    private handleConfigureAI(request: any): void {
        if (!this.orchestrator) {
            // If orchestrator is not ready, we can't update it yet.
            // But since this might be called early, we should try to initialize it or just log.
            // However, initialize() should have been called already.
            this.sendError(request.id, 'AI Orchestrator not initialized');
            return;
        }

        try {
            this.orchestrator.updateConfig(request.config);
            this.sendMessage({
                type: 'configure-ai-complete',
                id: request.id
            });
        } catch (error) {
            this.sendError(request.id, `Failed to update AI config: ${(error as Error).message}`);
        }
    }

    /**
     * Handle Refine Graph request (Architect Pass)
     */
    private async handleRefineGraph(id: string): Promise<void> {
        if (!this.db || !this.orchestrator) {
            this.sendError(id, 'Resource not initialized');
            return;
        }

        try {
            console.log('Worker: Starting graph refinement (Architect Pass)...');

            // 1. Get all files and generate skeletons
            const allFiles = this.db.getAllFiles();
            const fullSkeleton: Record<string, any> = {};

            for (const file of allFiles) {
                try {
                    const content = fs.readFileSync(file.filePath, 'utf-8');
                    const language = this.getLanguage(file.filePath);
                    if (language) {
                        fullSkeleton[file.filePath] = this.parser.generateStructuralSkeleton(content, language);
                    }
                } catch (e) {
                    console.error(`Worker: Failed to read file for skeleton: ${file.filePath}`, e);
                }
            }

            // 2. Call AI Orchestrator
            if (Object.keys(fullSkeleton).length === 0) {
                this.sendError(id, 'No code files found in index. Please run "Index Workspace" first.');
                return;
            }

            const refinedData = await this.orchestrator.refineSystemGraph(fullSkeleton);

            // 3. Update Symbols in DB
            const allSymbols = this.db.getAllSymbols();
            const symbolsToUpdate: { id: number; metadata: any }[] = [];

            // Result maps results back to symbols
            // We need to match based on ID or filePath + name + line
            for (const symbol of allSymbols) {
                const key = `${symbol.filePath}:${symbol.name}:${symbol.rangeStartLine}`;
                const metadata = refinedData.nodes[key];

                if (metadata) {
                    symbolsToUpdate.push({
                        id: symbol.id,
                        metadata: {
                            purpose: metadata.purpose,
                            impactDepth: metadata.impact_depth,
                            searchTags: metadata.search_tags ? JSON.stringify(metadata.search_tags) : null,
                            fragility: metadata.fragility
                        }
                    });
                }
            }

            // Perform batch update (need to implement updateSymbolMetadata in database.ts)
            if (symbolsToUpdate.length > 0) {
                this.db.updateSymbolsMetadata(symbolsToUpdate);
            }

            // 4. Update Edges (Implicit links)
            if (refinedData.implicit_links && refinedData.implicit_links.length > 0) {
                console.log(`Worker: Resolving ${refinedData.implicit_links.length} implicit links...`);
                const implicitEdges: any[] = [];

                // Helper to resolve string ID to database ID
                // We'll use the symbols already in the DB to match.
                // For performance, we can build a lookup map of all current symbols.
                const idMap = new Map<string, number>();
                allSymbols.forEach(s => {
                    const key = `${s.filePath}:${s.name}:${s.rangeStartLine}`;
                    idMap.set(key, s.id);
                });

                for (const link of refinedData.implicit_links) {
                    const sourceId = idMap.get(link.sourceId);
                    const targetId = idMap.get(link.targetId);

                    if (sourceId && targetId) {
                        implicitEdges.push({
                            sourceId,
                            targetId,
                            type: 'implicit',
                            reason: link.reason
                        });
                    }
                }

                if (implicitEdges.length > 0) {
                    console.log(`Worker: Inserting ${implicitEdges.length} resolved implicit links.`);
                    this.db.insertEdges(implicitEdges);
                }
            }

            this.sendMessage({
                type: 'refine-graph-complete',
                id,
                refinedNodeCount: symbolsToUpdate.length,
                implicitLinkCount: refinedData.implicit_links?.length || 0
            });

        } catch (error) {
            console.error('Worker: Refine graph failed:', error);
            this.sendError(id, `Refine graph failed: ${(error as Error).message}`);
        }
    }

    private getLanguage(filePath: string): 'typescript' | 'python' | 'c' | null {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === '.ts' || ext === '.tsx') return 'typescript';
        if (ext === '.py') return 'python';
        if (ext === '.c' || ext === '.h') return 'c';
        return null;
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
