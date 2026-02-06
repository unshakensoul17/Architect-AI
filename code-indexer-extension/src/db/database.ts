// Purpose: Database operations layer
// Provides type-safe CRUD operations for symbols, edges, files, and metadata
// ALL database access happens in the worker thread only

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, like } from 'drizzle-orm';
import { symbols, edges, files, meta, NewSymbol, NewEdge, Symbol, Edge, File } from './schema';
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
    `);
    }

    /**
     * Insert multiple symbols in a transaction
     * Returns array of inserted symbol IDs
     */
    insertSymbols(symbolsData: NewSymbol[]): number[] {
        const insertedIds: number[] = [];

        const insertStmt = this.db.prepare(`
      INSERT INTO symbols (name, type, file_path, range_start_line, range_start_column, 
                          range_end_line, range_end_column, complexity)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
                    item.complexity || 0
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

    /**
     * Close database connection
     */
    close(): void {
        this.db.close();
    }
}
