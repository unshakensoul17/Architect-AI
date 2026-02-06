// Purpose: Database operations layer
// Provides type-safe CRUD operations for symbols, edges, and metadata
// ALL database access happens in the worker thread only

import Database from 'better-sqlite3';
import { drizzle, BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { eq, and } from 'drizzle-orm';
import { symbols, edges, meta, NewSymbol, NewEdge, Symbol, Edge } from './schema';
import * as path from 'path';
import * as fs from 'fs';

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
                insertStmt.run(item.sourceId, item.targetId, item.type);
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
            .prepare('SELECT COUNT(DISTINCT file_path) as count FROM symbols')
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
