// Purpose: Database operations layer
// Provides type-safe CRUD operations for symbols, edges, files, and metadata
// ALL database access happens in the worker thread only

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, like, and } from 'drizzle-orm';
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

/**
 * Architecture Skeleton (Macro View)
 */
export interface ArchitectureSkeleton {
    nodes: SkeletonNodeData[];
    edges: SkeletonEdge[];
}

export interface SkeletonNodeData {
    id: string; // Relative path
    name: string; // Basename or Semantic Domain Name
    type: 'file' | 'folder';
    symbolCount: number;
    avgComplexity: number;
    avgFragility: number;
    totalBlastRadius: number;
    isFolder: boolean;
    depth: number;
    domainName?: string;
    children?: SkeletonNodeData[];
    importPaths?: string[]; // Used for AI semantic pass
}

export interface SkeletonEdge {
    source: string; // Relative filePath
    target: string; // Relative filePath
    weight: number; // import/call count
}

/**
 * Function Trace (Micro View)
 */
export interface FunctionTrace {
    symbolId: number;
    nodes: TraceNode[];
    edges: TraceEdge[];
}

export interface TraceNode {
    id: string; // "filePath:name:line" or similar
    label: string;
    type: string; // function, class, etc.
    filePath: string;
    line: number;
    isSink: boolean; // DB or API call
    depth: number; // relative to target
    blastRadius?: number;
    complexity: number;
}

export interface TraceEdge {
    source: string;
    target: string;
    type: 'call' | 'import';
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
        complexity INTEGER NOT NULL DEFAULT 0,
        domain TEXT,
        purpose TEXT,
        impact_depth INTEGER,
        search_tags TEXT,
        fragility TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
      CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
      CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);

      CREATE TABLE IF NOT EXISTS edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id INTEGER NOT NULL,
        target_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        reason TEXT,
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

        // Migrations: Add new columns if they don't exist
        try {
            const symbolsInfo = this.db.prepare("PRAGMA table_info(symbols)").all() as Array<{ name: string }>;
            const existingSymbolCols = symbolsInfo.map(col => col.name);

            const migrations = [
                { name: 'domain', type: 'TEXT' },
                { name: 'purpose', type: 'TEXT' },
                { name: 'impact_depth', type: 'INTEGER' },
                { name: 'search_tags', type: 'TEXT' },
                { name: 'fragility', type: 'TEXT' },
                { name: 'risk_score', type: 'INTEGER' },
                { name: 'risk_reason', type: 'TEXT' }
            ];

            for (const migration of migrations) {
                if (!existingSymbolCols.includes(migration.name)) {
                    console.log(`Migrating symbols table: Adding ${migration.name} column...`);
                    this.db.exec(`ALTER TABLE symbols ADD COLUMN ${migration.name} ${migration.type}`);
                    if (migration.name === 'domain') {
                        this.db.exec('CREATE INDEX IF NOT EXISTS idx_symbols_domain ON symbols(domain)');
                    }
                }
            }

            // Migration for edges table
            const edgesInfo = this.db.prepare("PRAGMA table_info(edges)").all() as Array<{ name: string }>;
            if (!edgesInfo.some(col => col.name === 'reason')) {
                console.log('Migrating edges table: Adding reason column...');
                this.db.exec('ALTER TABLE edges ADD COLUMN reason TEXT');
            }

            // Create technical_debt table if it doesn't exist
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS technical_debt (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    symbol_id INTEGER NOT NULL,
                    smell_type TEXT NOT NULL,
                    severity TEXT NOT NULL,
                    description TEXT NOT NULL,
                    detected_at TEXT NOT NULL,
                    FOREIGN KEY (symbol_id) REFERENCES symbols(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_debt_symbol ON technical_debt(symbol_id);
                CREATE INDEX IF NOT EXISTS idx_debt_severity ON technical_debt(severity);
            `);
        } catch (error) {
            console.error('Migration error:', error);
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
                          range_end_line, range_end_column, complexity, domain, 
                          purpose, impact_depth, search_tags, fragility, risk_score, risk_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                    item.domain || null,
                    item.purpose || null,
                    item.impactDepth || null,
                    item.searchTags || null,
                    item.fragility || null,
                    (item as any).riskScore || null,
                    (item as any).riskReason || null
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
      INSERT INTO edges (source_id, target_id, type, reason)
      VALUES (?, ?, ?, ?)
    `);

        const transaction = this.db.transaction((items: NewEdge[]) => {
            for (const item of items) {
                // Only insert if both source and target are valid
                if (item.sourceId && item.targetId) {
                    insertStmt.run(item.sourceId, item.targetId, item.type, item.reason || null);
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
     * Get all symbols belonging to a specific domain
     * Used by InspectorService for domain health calculation
     */
    getSymbolsByDomain(domain: string): Symbol[] {
        const rows = this.db.prepare(`
            SELECT * FROM symbols WHERE domain = ?
        `).all(domain) as any[];
        return rows.map(r => ({
            id: r.id,
            name: r.name,
            type: r.type,
            filePath: r.file_path,
            rangeStartLine: r.range_start_line,
            rangeStartColumn: r.range_start_column,
            rangeEndLine: r.range_end_line,
            rangeEndColumn: r.range_end_column,
            complexity: r.complexity,
            domain: r.domain,
            purpose: r.purpose,
            impactDepth: r.impact_depth,
            searchTags: r.search_tags,
            fragility: r.fragility,
        }));
    }

    /**
     * Get cross-domain vs total edge counts for a domain
     * Used to compute coupling ratio (cross-domain / total)
     */
    getDomainEdgeCounts(domain: string): { crossDomain: number; total: number } {
        // All edges where source symbol is in this domain
        const totalRow = this.db.prepare(`
            SELECT COUNT(*) as cnt
            FROM edges e
            JOIN symbols s ON e.source_id = s.id
            WHERE s.domain = ?
        `).get(domain) as { cnt: number };

        // Edges where target symbol is in a DIFFERENT domain
        const crossRow = this.db.prepare(`
            SELECT COUNT(*) as cnt
            FROM edges e
            JOIN symbols src ON e.source_id = src.id
            JOIN symbols tgt ON e.target_id = tgt.id
            WHERE src.domain = ? AND (tgt.domain IS NULL OR tgt.domain != ?)
        `).get(domain, domain) as { cnt: number };

        return {
            total: totalRow?.cnt ?? 0,
            crossDomain: crossRow?.cnt ?? 0,
        };
    }

    /**
     * Get import and export edge counts for a file
     * importCount = edges pointing OUT of any symbol in this file (this file imports others)
     * exportCount = edges pointing INTO symbols in this file (others import from this file)
     */
    getFileEdgeCounts(filePath: string): { importCount: number; exportCount: number } {
        const importRow = this.db.prepare(`
            SELECT COUNT(*) as cnt
            FROM edges e
            JOIN symbols src ON e.source_id = src.id
            JOIN symbols tgt ON e.target_id = tgt.id
            WHERE src.file_path = ? AND tgt.file_path != ?
              AND e.type = 'import'
        `).get(filePath, filePath) as { cnt: number };

        const exportRow = this.db.prepare(`
            SELECT COUNT(*) as cnt
            FROM edges e
            JOIN symbols src ON e.source_id = src.id
            JOIN symbols tgt ON e.target_id = tgt.id
            WHERE tgt.file_path = ? AND src.file_path != ?
              AND e.type = 'import'
        `).get(filePath, filePath) as { cnt: number };

        return {
            importCount: importRow?.cnt ?? 0,
            exportCount: exportRow?.cnt ?? 0,
        };
    }


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
     * Get symbol by exact location
     */
    getSymbolByLocation(filePath: string, name: string, line: number): Symbol | null {
        const symbol = this.drizzle
            .select()
            .from(symbols)
            .where(
                and(
                    eq(symbols.filePath, filePath),
                    eq(symbols.name, name),
                    eq(symbols.rangeStartLine, line)
                )
            )
            .get();

        return symbol || null;
    }

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
                    domain: row.domain,
                    purpose: row.purpose,
                    impactDepth: row.impact_depth,
                    searchTags: row.search_tags,
                    fragility: row.fragility,
                    riskScore: row.risk_score,
                    riskReason: row.risk_reason,
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
                purpose: s.purpose,
                impactDepth: s.impactDepth,
                searchTags: s.searchTags ? JSON.parse(s.searchTags) : undefined,
                fragility: s.fragility,
                riskScore: (s as any).riskScore,
                riskReason: (s as any).riskReason,
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
                    reason: e.reason,
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
     * Calculate fragility for a symbol: Complexity * Out-Degree
     */
    calculateFragility(symbolId: number): number {
        const symbol = this.getSymbolById(symbolId);
        if (!symbol) return 0;

        const outEdges = this.db.prepare('SELECT COUNT(*) as count FROM edges WHERE source_id = ?').get(symbolId) as { count: number };
        const coupling = outEdges.count || 0;

        return symbol.complexity * (coupling + 1); // +1 to ensure isolated complex nodes have a baseline fragility
    }

    /**
     * Calculate Blast Radius: Recursive count of symbols that depend on this one
     */
    calculateBlastRadius(symbolId: number, maxDepth: number = 5): number {
        const visited = new Set<number>();
        const queue: { id: number; depth: number }[] = [{ id: symbolId, depth: 0 }];

        while (queue.length > 0) {
            const { id, depth } = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);

            if (depth < maxDepth) {
                const callers = this.db.prepare('SELECT source_id FROM edges WHERE target_id = ?').all(id) as { source_id: number }[];
                for (const caller of callers) {
                    queue.push({ id: caller.source_id, depth: depth + 1 });
                }
            }
        }

        return visited.size - 1; // Don't count the starting symbol itself
    }

    // ========== Architecture Skeleton (Macro View) ==========

    async getArchitectureSkeleton(refineWithAI: boolean = false): Promise<ArchitectureSkeleton> {
        let skeleton: ArchitectureSkeleton | null = null;
        const cached = this.getMeta('architecture_skeleton');

        if (cached) {
            try {
                skeleton = JSON.parse(cached);
                // If cache is empty but we likely have data, force regeneration
                if (skeleton && skeleton.nodes.length === 0) {
                    const count = (this.db.prepare('SELECT COUNT(*) as count FROM symbols').get() as any).count;
                    if (count > 0) skeleton = null;
                }
            } catch (e) {
                console.error('Failed to parse cached skeleton', e);
            }
        }

        if (!skeleton) {
            skeleton = this.generateArchitectureSkeleton();
        }

        if (refineWithAI) {
            skeleton = await this.refineArchitectureLabelsWithAI(skeleton);
            this.setMeta('architecture_skeleton', JSON.stringify(skeleton));
        } else if (!cached || !skeleton) {
            this.setMeta('architecture_skeleton', JSON.stringify(skeleton));
        }

        return skeleton;
    }

    private async refineArchitectureLabelsWithAI(skeleton: ArchitectureSkeleton): Promise<ArchitectureSkeleton> {
        if (!this.orchestrator) return skeleton;

        // Collect folders that need labeling (typically depth 1 or 2)
        const foldersToLabel: { path: string, imports: string[] }[] = [];

        const traverse = (nodes: SkeletonNodeData[]) => {
            for (const node of nodes) {
                if (node.isFolder && node.depth <= 2) {
                    foldersToLabel.push({
                        path: node.id,
                        imports: node.importPaths || []
                    });
                }
                if (node.children) {
                    traverse(node.children);
                }
            }
        };

        traverse(skeleton.nodes);

        if (foldersToLabel.length === 0) return skeleton;

        const labels = await this.orchestrator.semanticModuleLabeling(foldersToLabel);

        // Apply labels
        const applyLabels = (nodes: SkeletonNodeData[]) => {
            for (const node of nodes) {
                if (labels[node.id]) {
                    node.domainName = labels[node.id];
                }
                if (node.children) {
                    applyLabels(node.children);
                }
            }
        };

        applyLabels(skeleton.nodes);

        return skeleton;
    }

    private generateArchitectureSkeleton(): ArchitectureSkeleton {
        // 1. Get all file paths and determine workspace root (fallback to common prefix)
        const fileResults = this.db.prepare(`SELECT DISTINCT file_path FROM symbols`).all() as { file_path: string }[];
        const rawFilePaths = fileResults.map(f => f.file_path);

        if (rawFilePaths.length === 0) return { nodes: [], edges: [] };

        // Determine common prefix to use as relative root
        const workspaceRoot = this.findCommonPrefix(rawFilePaths);

        // 2. Filter and normalize paths
        const ignoredPatterns = ['.next', 'node_modules', '.git', 'types', 'dist', 'build', '.venv', '__pycache__'];
        const filteredFiles = rawFilePaths.filter(fp => {
            const relPath = path.relative(workspaceRoot, fp);
            const segments = relPath.split(path.sep);

            // Don't filter out everything if workspaceRoot is '/'
            if (relPath === fp && fp.startsWith('/')) {
                // If it's still absolute, only filter if any segment matches
                return !segments.some(s => ignoredPatterns.includes(s));
            }

            return !segments.some(s => ignoredPatterns.includes(s));
        });

        const nodesMap = new Map<string, SkeletonNodeData>();
        const root: SkeletonNodeData[] = [];

        // Helper to get or create folder nodes
        const getOrCreateFolder = (relPath: string): SkeletonNodeData => {
            if (nodesMap.has(relPath)) return nodesMap.get(relPath)!;

            const parts = relPath.split(path.sep);
            const name = parts[parts.length - 1];
            const depth = parts.length;

            const folderNode: SkeletonNodeData = {
                id: relPath,
                name,
                type: 'folder',
                symbolCount: 0,
                avgComplexity: 0,
                avgFragility: 0,
                totalBlastRadius: 0,
                isFolder: true,
                depth,
                children: []
            };

            nodesMap.set(relPath, folderNode);

            // Link to parent
            if (parts.length > 1) {
                const parentPath = parts.slice(0, -1).join(path.sep);
                const parent = getOrCreateFolder(parentPath);
                parent.children!.push(folderNode);
            } else {
                root.push(folderNode);
            }

            return folderNode;
        };

        // 3. Create file nodes and build basic tree
        for (const fp of filteredFiles) {
            const relPath = path.relative(workspaceRoot, fp);
            const parts = relPath.split(path.sep);

            const symbolsInFile = this.db.prepare(`SELECT id, complexity FROM symbols WHERE file_path = ?`).all(fp) as { id: number; complexity: number }[];

            let totalComplexity = 0;
            let totalFragility = 0;
            let maxBlastRadius = 0;

            for (const s of symbolsInFile) {
                totalComplexity += s.complexity;
                totalFragility += this.calculateFragility(s.id);
                const br = this.calculateBlastRadius(s.id);
                if (br > maxBlastRadius) maxBlastRadius = br;
            }

            // Get primary imports/dependencies for AI semantic pass
            const outgoingEdges = this.db.prepare(`
                SELECT DISTINCT s2.file_path 
                FROM edges e 
                JOIN symbols s2 ON e.target_id = s2.id 
                WHERE e.source_id IN (SELECT id FROM symbols WHERE file_path = ?)
                AND s2.file_path != ?
            `).all(fp, fp) as { file_path: string }[];

            const fileNode: SkeletonNodeData = {
                id: relPath,
                name: path.basename(relPath),
                type: 'file',
                symbolCount: symbolsInFile.length,
                avgComplexity: symbolsInFile.length > 0 ? totalComplexity / symbolsInFile.length : 0,
                avgFragility: symbolsInFile.length > 0 ? totalFragility / symbolsInFile.length : 0,
                totalBlastRadius: maxBlastRadius,
                isFolder: false,
                depth: parts.length,
                importPaths: outgoingEdges.map(e => path.relative(workspaceRoot, e.file_path))
            };

            nodesMap.set(relPath, fileNode);

            if (parts.length > 1) {
                const parentPath = parts.slice(0, -1).join(path.sep);
                const parent = getOrCreateFolder(parentPath);
                parent.children!.push(fileNode);
            } else {
                root.push(fileNode);
            }
        }

        // 4. Bottom-up metric aggregation for folder nodes
        const aggregateMetrics = (node: SkeletonNodeData) => {
            if (!node.isFolder || !node.children) return;

            node.children.forEach(aggregateMetrics);

            let totalSymbols = 0;
            let weightedComplexitySum = 0;
            let totalFragilitySum = 0;
            let maxBlastRadius = 0;
            const folderImports = new Set<string>();

            for (const child of node.children) {
                totalSymbols += child.symbolCount;
                weightedComplexitySum += child.avgComplexity * child.symbolCount;
                totalFragilitySum += child.avgFragility; // Sum of fragility
                if (child.totalBlastRadius > maxBlastRadius) maxBlastRadius = child.totalBlastRadius;

                if (child.importPaths) {
                    child.importPaths.forEach(p => folderImports.add(p));
                }
            }

            node.symbolCount = totalSymbols;
            node.avgComplexity = totalSymbols > 0 ? Math.round((weightedComplexitySum / totalSymbols) * 10) / 10 : 0;
            node.avgFragility = Math.round(totalFragilitySum * 10) / 10;
            node.totalBlastRadius = maxBlastRadius;
            node.importPaths = Array.from(folderImports).slice(0, 20); // Limit to 20 for AI context
        };

        root.forEach(aggregateMetrics);

        // 5. Build relative edges
        const edgeStats = this.db.prepare(`
            SELECT 
                s1.file_path as source_file,
                s2.file_path as target_file,
                COUNT(*) as weight
            FROM edges e
            JOIN symbols s1 ON e.source_id = s1.id
            JOIN symbols s2 ON e.target_id = s2.id
            WHERE s1.file_path != s2.file_path
            GROUP BY s1.file_path, s2.file_path
        `).all() as { source_file: string; target_file: string; weight: number }[];

        const edgesList: SkeletonEdge[] = [];
        for (const stat of edgeStats) {
            const sourceRel = path.relative(workspaceRoot, stat.source_file);
            const targetRel = path.relative(workspaceRoot, stat.target_file);

            // Only include edges between files that weren't ignored
            if (nodesMap.has(sourceRel) && nodesMap.has(targetRel)) {
                edgesList.push({
                    source: sourceRel,
                    target: targetRel,
                    weight: stat.weight
                });
            }
        }

        // 6. Phase 2: Domain Mapping (Initial Heuristic)
        this.assignDomainToFolders(root);

        return { nodes: root, edges: edgesList };
    }

    /**
     * Get workspace root using common prefix heuristic
     */
    getWorkspaceRootHeuristic(): string {
        const allFiles = this.getAllFiles();
        if (allFiles.length === 0) return '/';
        return this.findCommonPrefix(allFiles.map(f => f.filePath));
    }

    private findCommonPrefix(paths: string[]): string {
        if (paths.length === 0) return '';
        if (paths.length === 1) return path.dirname(paths[0]);

        const sorted = paths.concat().sort();
        const a1 = sorted[0], a2 = sorted[sorted.length - 1], L = a1.length, i = 0;
        let prefix = '';
        const parts1 = a1.split(path.sep);
        const parts2 = a2.split(path.sep);
        const commonParts = [];
        for (let j = 0; j < Math.min(parts1.length, parts2.length); j++) {
            if (parts1[j] === parts2[j]) {
                commonParts.push(parts1[j]);
            } else {
                break;
            }
        }
        return commonParts.join(path.sep) || path.sep;
    }

    private assignDomainToFolders(nodes: SkeletonNodeData[]) {
        const domainHeuristics: Record<string, string> = {
            'src/app': 'User Interface',
            'src/api': 'API Layer',
            'src/lib': 'Infrastructure/Utils',
            'src/components': 'UI Components',
            'src/hooks': 'React Hooks',
            'src/services': 'Business Services',
            'src/worker': 'Background Workers',
            'src/db': 'Data Layer',
        };

        const traverse = (node: SkeletonNodeData, inheritedDomain?: string) => {
            // Apply heuristic or inherited
            let domain = inheritedDomain;
            if (domainHeuristics[node.id]) {
                domain = domainHeuristics[node.id];
            }

            if (domain) {
                node.domainName = domain;
            }

            if (node.children) {
                node.children.forEach(child => traverse(child, domain));
            }
        };

        nodes.forEach(node => traverse(node));
    }

    // ========== Function Trace (Micro View) ==========

    getFunctionTrace(symbolId: number): FunctionTrace {
        const rootSymbol = this.getSymbolById(symbolId);
        if (!rootSymbol) {
            throw new Error(`Symbol not found: ${symbolId}`);
        }

        const nodes = new Map<string, TraceNode>();
        const traceEdges: TraceEdge[] = [];
        const visitedEdges = new Set<string>();

        // BFS State
        const queue: { id: number; depth: number }[] = [{ id: symbolId, depth: 0 }];
        const visited = new Set<number>();

        while (queue.length > 0) {
            const { id, depth } = queue.shift()!;
            if (visited.has(id)) continue;
            visited.add(id);

            // Depth limits: 1 level up, 3 levels down
            if (depth < -1 || depth > 3) continue;

            const symbol = this.getSymbolById(id);
            if (!symbol) continue;

            // Add Node
            const nodeId = `${symbol.filePath}:${symbol.name}:${symbol.rangeStartLine}`;
            if (!nodes.has(nodeId)) {
                // Heuristic for "sink"
                const nameLower = symbol.name.toLowerCase();
                const isSink =
                    (symbol.type === 'class' && (symbol.name.includes('DB') || symbol.name.includes('Service') || symbol.name.includes('Client'))) ||
                    nameLower.includes('fetch') ||
                    nameLower.includes('query') ||
                    nameLower.includes('execute') ||
                    nameLower.includes('request') ||
                    nameLower.includes('send') ||
                    symbol.filePath.includes('api') ||
                    symbol.filePath.includes('db');

                nodes.set(nodeId, {
                    id: nodeId,
                    label: symbol.name,
                    type: symbol.type,
                    filePath: symbol.filePath,
                    line: symbol.rangeStartLine,
                    isSink,
                    depth,
                    blastRadius: this.calculateBlastRadius(id),
                    complexity: symbol.complexity
                });
            }

            // Downstream (Callees)
            if (depth >= 0) {
                const outEdges = this.drizzle.select().from(edges).where(eq(edges.sourceId, id)).all();
                for (const edge of outEdges) {
                    const target = this.getSymbolById(edge.targetId);
                    if (target) {
                        const targetId = `${target.filePath}:${target.name}:${target.rangeStartLine}`;
                        const edgeKey = `${nodeId}->${targetId}`;

                        if (!visitedEdges.has(edgeKey)) {
                            traceEdges.push({ source: nodeId, target: targetId, type: edge.type as any });
                            visitedEdges.add(edgeKey);
                        }

                        queue.push({ id: edge.targetId, depth: depth + 1 });
                    }
                }
            }

            // Upstream (Callers)
            if (depth <= 0) {
                const inEdges = this.drizzle.select().from(edges).where(eq(edges.targetId, id)).all();
                for (const edge of inEdges) {
                    const source = this.getSymbolById(edge.sourceId);
                    if (source) {
                        const sourceId = `${source.filePath}:${source.name}:${source.rangeStartLine}`;
                        const edgeKey = `${sourceId}->${nodeId}`;

                        if (!visitedEdges.has(edgeKey)) {
                            traceEdges.push({ source: sourceId, target: nodeId, type: edge.type as any });
                            visitedEdges.add(edgeKey);
                        }

                        queue.push({ id: edge.sourceId, depth: depth - 1 });
                    }
                }
            }
        }

        return {
            symbolId,
            nodes: Array.from(nodes.values()),
            edges: traceEdges
        };
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
     * Get files belonging to a specific domain
     */
    getFilesByDomain(domain: string): File[] {
        // Find files that have at least one symbol in this domain
        const result = this.db.prepare(`
            SELECT DISTINCT f.*
        FROM files f
            JOIN symbols s ON s.file_path = f.file_path
            WHERE s.domain = ?
            `).all(domain) as any[];

        return result.map(row => ({
            id: row.id,
            filePath: row.file_path,
            contentHash: row.content_hash,
            lastIndexedAt: row.last_indexed_at
        }));
    }

    /**
     * Get file by path
     */
    getFile(filePath: string): { lastModified: string } | null {
        const file = this.db.prepare('SELECT last_indexed_at FROM files WHERE file_path = ?').get(filePath) as any;
        if (!file) return null;
        return { lastModified: file.last_indexed_at };
    }

    /**
     * Get statistics for a single file
     */
    getFileStats(filePath: string): {
        symbolCount: number;
        functionCount: number;
        importCount: number;
        exportCount: number;
        avgComplexity: number
    } {
        const stats = this.db.prepare(`
            SELECT 
                COUNT(*) as symbol_count,
            SUM(CASE WHEN type IN('function', 'method', 'constructor') THEN 1 ELSE 0 END) as function_count,
            AVG(complexity) as avg_complexity
            FROM symbols
            WHERE file_path = ?
            `).get(filePath) as any;

        // Note: import/export counts would require analyzing edges which is expensive here
        // We'll return 0 for now and let the inspector service calculate it if needed via edges
        return {
            symbolCount: stats.symbol_count || 0,
            functionCount: stats.function_count || 0,
            importCount: 0,
            exportCount: 0,
            avgComplexity: stats.avg_complexity || 0
        };
    }

    /**
     * Get incoming edges for a symbol
     */
    getIncomingEdges(symbolId: number): Edge[] {
        return this.drizzle
            .select()
            .from(edges)
            .where(eq(edges.targetId, symbolId))
            .all();
    }

    /**
     * Get outgoing edges for a symbol
     */
    getOutgoingEdges(symbolId: number): Edge[] {
        return this.drizzle
            .select()
            .from(edges)
            .where(eq(edges.sourceId, symbolId))
            .all();
    }

    /**
     * Update symbol metadata from AI analysis
     */
    updateSymbolsMetadata(updates: { id: number; metadata: any }[]): void {
        const updateStmt = this.db.prepare(`
            UPDATE symbols 
            SET purpose = ?, impact_depth = ?, search_tags = ?, fragility = ?,
                risk_score = ?, risk_reason = ?, domain = ?
            WHERE id = ?
        `);

        const transaction = this.db.transaction((items: { id: number; metadata: any }[]) => {
            for (const item of items) {
                updateStmt.run(
                    item.metadata.purpose || null,
                    item.metadata.impactDepth || null,
                    item.metadata.searchTags || null,
                    item.metadata.fragility || null,
                    item.metadata.riskScore ?? null,
                    item.metadata.riskReason || null,
                    item.metadata.domain || null,
                    item.id
                );
            }
        });

        transaction(updates);
    }

    /**
     * Insert technical debt items
     */
    insertTechnicalDebt(items: { symbolId: number; smellType: string; severity: string; description: string }[]): void {
        const now = new Date().toISOString();
        const insertStmt = this.db.prepare(`
            INSERT INTO technical_debt(symbol_id, smell_type, severity, description, detected_at)
            VALUES(?, ?, ?, ?, ?)
                `);

        const transaction = this.db.transaction(() => {
            // Clear existing debt items first
            this.db.prepare('DELETE FROM technical_debt').run();
            for (const item of items) {
                insertStmt.run(item.symbolId, item.smellType, item.severity, item.description, now);
            }
        });

        transaction();
    }

    /**
     * Get technical debt items for a symbol
     */
    getTechnicalDebt(symbolId: number): { smellType: string; severity: string; description: string }[] {
        const results = this.db.prepare(`
            SELECT smell_type, severity, description FROM technical_debt WHERE symbol_id = ?
            `).all(symbolId) as any[];

        return results.map(r => ({
            smellType: r.smell_type,
            severity: r.severity,
            description: r.description,
        }));
    }

    /**
     * Get all technical debt items
     */
    getAllTechnicalDebt(): { symbolId: number; smellType: string; severity: string; description: string }[] {
        const results = this.db.prepare(`
            SELECT symbol_id, smell_type, severity, description FROM technical_debt
            ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END
            `).all() as any[];

        return results.map(r => ({
            symbolId: r.symbol_id,
            smellType: r.smell_type,
            severity: r.severity,
            description: r.description,
        }));
    }

    // ========== Binary Pipeline: Bulk Ingestion Hooks ==========

    /**
     * Prepare the database for maximum-speed bulk ingestion.
     *
     * Drops all secondary indexes and disables journaling/sync so SQLite
     * can stream raw pages. Must be called before bulk insertSymbols() calls
     * and paired with postIndexOptimization() when ingestion is complete.
     *
     * WARNING: Do NOT call this during normal incremental indexing — only
     * during full workspace reindex operations.
     */
    preIndexCleanup(): void {
        console.log('DB: Entering bulk-ingest mode (indexes dropped, sync off)');
        this.db.exec(`
            -- Drop secondary indexes to speed up bulk writes
            DROP INDEX IF EXISTS idx_symbols_name;
            DROP INDEX IF EXISTS idx_symbols_file_path;
            DROP INDEX IF EXISTS idx_symbols_type;
            DROP INDEX IF EXISTS idx_symbols_domain;
            DROP INDEX IF EXISTS idx_edges_source;
            DROP INDEX IF EXISTS idx_edges_target;
            DROP INDEX IF EXISTS idx_edges_type;
            DROP INDEX IF EXISTS idx_files_path;
            DROP INDEX IF EXISTS idx_debt_symbol;
            DROP INDEX IF EXISTS idx_debt_severity;

            -- Disable safety features for raw insert speed
            PRAGMA foreign_keys = OFF;
            PRAGMA synchronous = OFF;
            PRAGMA journal_mode = MEMORY;
            PRAGMA cache_size = -65536;  -- 64MB page cache
            PRAGMA temp_store = MEMORY;
        `);
    }

    /**
     * Re-create all indexes and restore safety settings after bulk ingestion.
     * Runs ANALYZE so the query planner has accurate statistics.
     *
     * Call this once after all bulk insertSymbols()/insertEdges() calls are done.
     */
    postIndexOptimization(): void {
        console.log('DB: Rebuilding indexes and running ANALYZE...');
        this.db.exec(`
            -- Restore safety settings
            PRAGMA foreign_keys = ON;
            PRAGMA synchronous = NORMAL;
            PRAGMA journal_mode = WAL;

            -- Recreate all secondary indexes
            CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
            CREATE INDEX IF NOT EXISTS idx_symbols_file_path ON symbols(file_path);
            CREATE INDEX IF NOT EXISTS idx_symbols_type ON symbols(type);
            CREATE INDEX IF NOT EXISTS idx_symbols_domain ON symbols(domain);
            CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
            CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
            CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
            CREATE INDEX IF NOT EXISTS idx_files_path ON files(file_path);
            CREATE INDEX IF NOT EXISTS idx_debt_symbol ON technical_debt(symbol_id);
            CREATE INDEX IF NOT EXISTS idx_debt_severity ON technical_debt(severity);

            -- Refresh query planner statistics
            ANALYZE;
        `);
        console.log('DB: Post-index optimization complete.');
    }

    /**
     * High-throughput edge batch insert.
     * Wraps all edges in a single transaction with a pre-compiled statement.
     * Skips edges where source or target is 0 (unresolved).
     *
     * @param edges Array of {sourceId, targetId} pairs.
     * @param type  Edge type string ('call' | 'import').
     */
    insertEdgeBatch(edges: Array<{ sourceId: number; targetId: number }>, type: string): void {
        if (edges.length === 0) return;

        const stmt = this.db.prepare(
            'INSERT OR IGNORE INTO edges (source_id, target_id, type) VALUES (?, ?, ?)'
        );

        const run = this.db.transaction((items: Array<{ sourceId: number; targetId: number }>) => {
            for (const e of items) {
                if (e.sourceId > 0 && e.targetId > 0 && e.sourceId !== e.targetId) {
                    stmt.run(e.sourceId, e.targetId, type);
                }
            }
        });

        run(edges);
    }

    /**
     * Close database connection
     */
    close(): void {
        this.db.close();
    }
}
