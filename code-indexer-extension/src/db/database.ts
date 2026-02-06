// Purpose: Database operations layer
// Provides type-safe CRUD operations for symbols, edges, files, and metadata
// ALL database access happens in the worker thread only

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, like } from 'drizzle-orm';
import { symbols, edges, files, meta, aiCache, NewSymbol, NewEdge, Symbol, Edge, File, SymbolContext, AICacheEntry } from './schema';
import { computeDomainHealth, type DomainHealth } from '../domain/health';
import * as crypto from 'crypto';
import * as path from 'path';
import * as fs from 'fs';

export interface GraphExport {
    symbols: {
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
        domain?: string | null;
    }[];
    edges: {
        id: number;
        source: string;
        target: string;
        type: string;
    }[];
    files: {
        filePath: string;
        contentHash: string;
        lastIndexedAt: string;
    }[];
    domains: {
        domain: string;
        symbolCount: number;
        health: DomainHealth;
    }[];
}

export class CodeIndexDatabase {
    private db: Database.Database;
    private drizzle: BetterSQLite3Database;

    constructor(dbPath: string) {
        // Ensure database directory exists
        const dbDir = path.dirname(dbPath);
        if (!fs.existsSync(dbDir)) {
            fs.mkdirSync(dbDir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.drizzle = drizzle(this.db);

        this.initializeSchema();
    }

    /**
     * Initialize database schema
     * Creates tables if they don't exist
     */
    private initializeSchema(): void {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        file_path TEXT NOT NULL,
        range_start_line INTEGER NOT NULL,
        range_start_column INTEGER NOT NULL,
        range_end_line INTEGER NOT NULL,
        range_end_column INTEGER NOT NULL,
        complexity INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        FOREIGN KEY (source_id) REFERENCES symbols(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES symbols(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);

      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL UNIQUE,
        content_hash TEXT NOT NULL,
        last_indexed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_path ON files(file_path);

      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_cache (
        hash TEXT PRIMARY KEY,
        response TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS domain_metadata (
        domain TEXT PRIMARY KEY,
        health_score INTEGER NOT NULL,
        complexity INTEGER NOT NULL,
        coupling INTEGER NOT NULL,
        symbol_count INTEGER NOT NULL,
        last_updated TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS domain_cache (
        symbol_id INTEGER PRIMARY KEY,
        domain TEXT NOT NULL,
        confidence INTEGER NOT NULL,
        cached_at TEXT NOT NULL
      );
    `);

        // Migration: Add domain column to existing symbols table if it doesn't exist
        try {
            const tableInfo = this.db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
            const hasDomainColumn = tableInfo.some(col => col.name === 'domain');

            if (!hasDomainColumn) {
                console.log('Migrating database: Adding domain column to symbols table...');
                this.db.exec('ALTER TABLE symbols ADD COLUMN domain TEXT');
                this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_domain ON symbols(domain)');
                console.log('Migration complete: domain column added successfully');
            }
        } catch (error) {
            console.error('Migration error:', error);
            // Don't throw - table might not exist yet on first run
        }
    }

    /**
     * Insert multiple symbols in a transaction
     * Returns array of inserted symbol IDs
     */
    insertSymbols(symbolsData: NewSymbol[]): number[] {
        const insertedIds: number[] = [];

        const insertStmt = this.db.prepare(`
      INSERT INTO symbols (name, type, file_path, range_start_line, range_start_column, 
                          range_end_line, range_end_column, complexity, domain)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        const transaction = this.db.transaction((items: NewSymbol[]) => {
            for (const item of items) {
                const info = insertStmt.run(
                    item.name,
                    item.type,
                    item.filePath,
                    item.rangeStartLine,
                    item.rangeStartColumn,
                    item.rangeEndLine,
                    item.rangeEndColumn,
                    item.complexity || 0,
                    item.domain || null
                );
                insertedIds.push(Number(info.lastInsertRowid));
            }
        });

        transaction(symbolsData);
        return insertedIds;
    }

    /**
     * Insert multiple edges in a transaction
     */
    insertEdges(edgesData: NewEdge[]): void {
        const insertStmt = this.db.prepare(`
      INSERT INTO edges (source_id, target_id, type)
      VALUES (?, ?, ?)
    `);

        const transaction = this.db.transaction((items: NewEdge[]) => {
            for (const item of items) {
                // Only insert if both source and target are valid
                if (item.sourceId && item.targetId) {
                    insertStmt.run(item.sourceId, item.targetId, item.type);
                }
            }
        });

        transaction(edgesData);
    }

    /**
     * Query symbols by file path
     */
    getSymbolsByFile(filePath: string): Symbol[] {
        return this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.filePath, filePath))
            .all();
    }

    /**
     * Query symbols by name
     */
    getSymbolsByName(name: string): Symbol[] {
        return this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.name, name))
            .all();
    }

    /**
     * Get all symbols
     */
    getAllSymbols(): Symbol[] {
        return this.drizzle.select().from(symbols).all();
    }

    /**
     * Get all edges
     */
    getAllEdges(): Edge[] {
        return this.drizzle.select().from(edges).all();
    }

    /**
     * Get all files
     */
    getAllFiles(): File[] {
        return this.drizzle.select().from(files).all();
    }

    /**
     * Get all symbols with their outgoing edges
     */
    getSymbolsWithEdges(symbolId: number): { symbol: Symbol; edges: Edge[] } | null {
        const symbol = this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.id, symbolId))
            .get();

        if (!symbol) return null;

        const symbolEdges = this.drizzle
            .select()
            .from(edges)
            .where(eq(edges.sourceId, symbolId))
            .all();

        return { symbol, edges: symbolEdges };
    }

    // ========== Context Assembly (cAST) ==========

    /**
     * Symbol context including code and neighbors for AI prompts
     */
    getSymbolWithContext(symbolId: number): SymbolContext | null {
        // Get the target symbol
        const symbol = this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.id, symbolId))
            .get();

        if (!symbol) return null;

        // Get outgoing edges (this symbol depends on...)
        const outgoingEdges = this.drizzle
            .select()
            .from(edges)
            .where(eq(edges.sourceId, symbolId))
            .all();

        // Get incoming edges (...depends on this symbol)
        const incomingEdges = this.drizzle
            .select()
            .from(edges)
            .where(eq(edges.targetId, symbolId))
            .all();

        // Collect neighbor IDs (1st-degree connections)
        const neighborIds = new Set<number>();
        outgoingEdges.forEach(e => neighborIds.add(e.targetId));
        incomingEdges.forEach(e => neighborIds.add(e.sourceId));

        // Fetch all neighbors in one query
        const neighbors: Symbol[] = [];
        if (neighborIds.size > 0) {
            const neighborIdArray = Array.from(neighborIds);
            const stmt = this.db.prepare(`
                SELECT * FROM symbols WHERE id IN (${neighborIdArray.map(() => '?').join(',')})
            `);
            const results = stmt.all(...neighborIdArray) as any[];
            for (const row of results) {
                neighbors.push({
                    id: row.id,
                    name: row.name,
                    type: row.type,
                    filePath: row.file_path,
                    rangeStartLine: row.range_start_line,
                    rangeStartColumn: row.range_start_column,
                    rangeEndLine: row.range_end_line,
                    rangeEndColumn: row.range_end_column,
                    complexity: row.complexity,
                });
            }
        }

        return {
            symbol,
            neighbors,
            incomingEdges,
            outgoingEdges,
        };
    }

    /**
     * Get symbol by name (for MCP tool queries)
     */
    getSymbolByName(name: string): Symbol | null {
        return this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.name, name))
            .get() || null;
    }

    /**
     * Get symbol by ID (for MCP tool queries)
     */
    getSymbolById(symbolId: number): Symbol | null {
        return this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.id, symbolId))
            .get() || null;
    }

    /**
     * Get dependencies for a symbol (for MCP tool)
     */
    getDependencies(symbolId: number, direction: 'incoming' | 'outgoing' | 'both' = 'both'): {
        incoming: { edge: Edge; symbol: Symbol }[];
        outgoing: { edge: Edge; symbol: Symbol }[];
    } {
        const result: {
            incoming: { edge: Edge; symbol: Symbol }[];
            outgoing: { edge: Edge; symbol: Symbol }[];
        } = { incoming: [], outgoing: [] };

        if (direction === 'outgoing' || direction === 'both') {
            const outEdges = this.drizzle
                .select()
                .from(edges)
                .where(eq(edges.sourceId, symbolId))
                .all();

            for (const edge of outEdges) {
                const symbol = this.getSymbolById(edge.targetId);
                if (symbol) {
                    result.outgoing.push({ edge, symbol });
                }
            }
        }

        if (direction === 'incoming' || direction === 'both') {
            const inEdges = this.drizzle
                .select()
                .from(edges)
                .where(eq(edges.targetId, symbolId))
                .all();

            for (const edge of inEdges) {
                const symbol = this.getSymbolById(edge.sourceId);
                if (symbol) {
                    result.incoming.push({ edge, symbol });
                }
            }
        }

        return result;
    }

    /**
     * Delete all symbols for a given file
     * Edges are automatically deleted due to CASCADE
     */
    deleteSymbolsByFile(filePath: string): void {
        this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(filePath);
    }

    /**
     * Clear entire index
     */
    clearIndex(): void {
        this.db.exec(`
      DELETE FROM edges;
      DELETE FROM symbols;
      DELETE FROM files;
      DELETE FROM meta;
    `);
    }

    /**
     * Set metadata value
     */
    setMeta(key: string, value: string): void {
        this.db
            .prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
            .run(key, value);
    }

    /**
     * Get metadata value
     */
    getMeta(key: string): string | null {
        const result = this.db
            .prepare('SELECT value FROM meta WHERE key = ?')
            .get(key) as { value: string } | undefined;
        return result?.value ?? null;
    }

    // ========== File Tracking for Incremental Indexing ==========

    /**
     * Get file hash from database
     */
    getFileHash(filePath: string): string | null {
        const result = this.db
            .prepare('SELECT content_hash FROM files WHERE file_path = ?')
            .get(filePath) as { content_hash: string } | undefined;
        return result?.content_hash ?? null;
    }

    /**
     * Set file hash after indexing
     */
    setFileHash(filePath: string, contentHash: string): void {
        const now = new Date().toISOString();
        this.db
            .prepare(`
        INSERT OR REPLACE INTO files (file_path, content_hash, last_indexed_at)
        VALUES (?, ?, ?)
      `)
            .run(filePath, contentHash, now);
    }

    /**
     * Compute content hash using SHA-256
     */
    static computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Check if file needs re-indexing
     * Returns true if file is new or content has changed
     */
    needsReindex(filePath: string, content: string): boolean {
        const storedHash = this.getFileHash(filePath);
        if (!storedHash) return true;

        const currentHash = CodeIndexDatabase.computeHash(content);
        return storedHash !== currentHash;
    }

    // ========== AI Cache ==========

    /**
     * Get cached AI response
     */
    getAICache(hash: string): AICacheEntry | null {
        return this.drizzle
            .select()
            .from(aiCache)
            .where(eq(aiCache.hash, hash))
            .get() || null;
    }

    /**
     * Set cached AI response
     */
    setAICache(hash: string, response: string): void {
        const now = new Date().toISOString();
        this.db
            .prepare('INSERT OR REPLACE INTO ai_cache (hash, response, created_at) VALUES (?, ?, ?)')
            .run(hash, response, now);
    }

    // ========== Graph Export ==========

    /**
     * Export entire graph as JSON
     */
    exportGraph(): GraphExport {
        const allSymbols = this.getAllSymbols();
        const allEdges = this.getAllEdges();
        const allFiles = this.getAllFiles();

        // Build symbol ID to name map for edge export
        const symbolMap = new Map<number, Symbol>();
        for (const sym of allSymbols) {
            symbolMap.set(sym.id, sym);
        }

        // Group symbols by domain
        const symbolsByDomain = new Map<string, Symbol[]>();
        for (const symbol of allSymbols) {
            const domain = symbol.domain || 'unknown';
            if (!symbolsByDomain.has(domain)) {
                symbolsByDomain.set(domain, []);
            }
            symbolsByDomain.get(domain)!.push(symbol);
        }

        // Compute cross-domain edges for coupling metrics
        const domainEdgeCounts = new Map<string, { total: number; crossDomain: number }>();
        for (const edge of allEdges) {
            const source = symbolMap.get(edge.sourceId);
            const target = symbolMap.get(edge.targetId);

            if (source && target) {
                const sourceDomain = source.domain || 'unknown';
                const targetDomain = target.domain || 'unknown';

                if (!domainEdgeCounts.has(sourceDomain)) {
                    domainEdgeCounts.set(sourceDomain, { total: 0, crossDomain: 0 });
                }

                const counts = domainEdgeCounts.get(sourceDomain)!;
                counts.total++;
                if (sourceDomain !== targetDomain) {
                    counts.crossDomain++;
                }
            }
        }

        // Compute domain health metrics
        const domains: { domain: string; symbolCount: number; health: DomainHealth }[] = [];
        for (const [domain, domainSymbols] of symbolsByDomain) {
            const edgeStats = domainEdgeCounts.get(domain) || { total: 0, crossDomain: 0 };
            const health = computeDomainHealth(
                domain,
                domainSymbols,
                edgeStats.crossDomain,
                edgeStats.total
            );

            // Store health metrics in database
            this.setDomainMetadata(
                domain,
                health.healthScore,
                health.avgComplexity,
                health.coupling,
                health.symbolCount
            );

            domains.push({ domain, symbolCount: domainSymbols.length, health });
        }

        return {
            symbols: allSymbols.map((s) => ({
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
                domain: s.domain,
            })),
            edges: allEdges.map((e) => {
                const sourceSymbol = symbolMap.get(e.sourceId);
                const targetSymbol = symbolMap.get(e.targetId);
                return {
                    id: e.id,
                    source: sourceSymbol
                        ? `${sourceSymbol.filePath}:${sourceSymbol.name}:${sourceSymbol.rangeStartLine}`
                        : `unknown:${e.sourceId}`,
                    target: targetSymbol
                        ? `${targetSymbol.filePath}:${targetSymbol.name}:${targetSymbol.rangeStartLine}`
                        : `unknown:${e.targetId}`,
                    type: e.type,
                };
            }),
            files: allFiles.map((f) => ({
                filePath: f.filePath,
                contentHash: f.contentHash,
                lastIndexedAt: f.lastIndexedAt,
            })),
            domains: domains.sort((a, b) => b.health.healthScore - a.health.healthScore),
        };
    }

    /**
     * Get statistics about the index
     */
    getStats(): { symbolCount: number; edgeCount: number; fileCount: number } {
        const symbolCount = this.db
            .prepare('SELECT COUNT(*) as count FROM symbols')
            .get() as { count: number };

        const edgeCount = this.db
            .prepare('SELECT COUNT(*) as count FROM edges')
            .get() as { count: number };

        const fileCount = this.db
            .prepare('SELECT COUNT(*) as count FROM files')
            .get() as { count: number };

        return {
            symbolCount: symbolCount.count,
            edgeCount: edgeCount.count,
            fileCount: fileCount.count,
        };
    }

    // ========== Domain Operations ==========

    /**
     * Get symbols by domain
     */
    getSymbolsByDomain(domain: string): Symbol[] {
        return this.drizzle
            .select()
            .from(symbols)
            .where(eq(symbols.domain, domain))
            .all();
    }

    /**
     * Get domain statistics
     */
    getDomainStats(): { domain: string; symbolCount: number; avgComplexity: number }[] {
        const results = this.db.prepare(`
            SELECT 
                domain,
                COUNT(*) as symbol_count,
                AVG(complexity) as avg_complexity
            FROM symbols
            WHERE domain IS NOT NULL
            GROUP BY domain
            ORDER BY symbol_count DESC
        `).all() as any[];

        return results.map(r => ({
            domain: r.domain,
            symbolCount: r.symbol_count,
            avgComplexity: Math.round(r.avg_complexity * 10) / 10,
        }));
    }

    /**
     * Set domain metadata (health metrics)
     */
    setDomainMetadata(
        domain: string,
        healthScore: number,
        complexity: number,
        coupling: number,
        symbolCount: number
    ): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT OR REPLACE INTO domain_metadata 
            (domain, health_score, complexity, coupling, symbol_count, last_updated)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(domain, healthScore, complexity, coupling, symbolCount, now);
    }

    /**
     * Get domain metadata
     */
    getDomainMetadata(domain: string): {
        healthScore: number;
        complexity: number;
        coupling: number;
        symbolCount: number;
        lastUpdated: string;
    } | null {
        const result = this.db.prepare(`
            SELECT * FROM domain_metadata WHERE domain = ?
        `).get(domain) as any;

        if (!result) return null;

        return {
            healthScore: result.health_score,
            complexity: result.complexity,
            coupling: result.coupling,
            symbolCount: result.symbol_count,
            lastUpdated: result.last_updated,
        };
    }

    /**
     * Get all domain metadata
     */
    getAllDomainMetadata(): {
        domain: string;
        healthScore: number;
        complexity: number;
        coupling: number;
        symbolCount: number;
        lastUpdated: string;
    }[] {
        const results = this.db.prepare(`
            SELECT * FROM domain_metadata ORDER BY health_score DESC
        `).all() as any[];

        return results.map(r => ({
            domain: r.domain,
            healthScore: r.health_score,
            complexity: r.complexity,
            coupling: r.coupling,
            symbolCount: r.symbol_count,
            lastUpdated: r.last_updated,
        }));
    }

    /**
     * Set domain from cache
     */
    setDomainCache(symbolId: number, domain: string, confidence: number): void {
        const now = new Date().toISOString();
        this.db.prepare(`
            INSERT OR REPLACE INTO domain_cache (symbol_id, domain, confidence, cached_at)
            VALUES (?, ?, ?, ?)
        `).run(symbolId, domain, confidence, now);
    }

    /**
     * Get cached domain classification
     */
    getDomainCache(symbolId: number): { domain: string; confidence: number } | null {
        const result = this.db.prepare(`
            SELECT domain, confidence FROM domain_cache WHERE symbol_id = ?
        `).get(symbolId) as any;

        return result || null;
    }

    /**
     * Close database connection
     */
    close(): void {
        this.db.close();
    }
}
