// Purpose: Define the database schema for code indexing
// This schema represents the codebase as a graph:
// - symbols = nodes (functions, classes, variables)
// - edges = relationships (imports, calls, inheritance)
// - files = file tracking for incremental indexing
// - meta = indexing state and cache metadata

import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/**
 * Symbols Table
 * Stores all code symbols (functions, classes, variables, etc.)
 * extracted from the AST
 */
export const symbols = sqliteTable('symbols', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    type: text('type').notNull(), // function, class, variable, interface, etc.
    filePath: text('file_path').notNull(),
    rangeStartLine: integer('range_start_line').notNull(),
    rangeStartColumn: integer('range_start_column').notNull(),
    rangeEndLine: integer('range_end_line').notNull(),
    rangeEndColumn: integer('range_end_column').notNull(),
    complexity: integer('complexity').notNull().default(0),
});

/**
 * Edges Table
 * Stores relationships between symbols
 * (imports, function calls, inheritance, etc.)
 */
export const edges = sqliteTable('edges', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sourceId: integer('source_id')
        .notNull()
        .references(() => symbols.id, { onDelete: 'cascade' }),
    targetId: integer('target_id')
        .notNull()
        .references(() => symbols.id, { onDelete: 'cascade' }),
    type: text('type').notNull(), // import, call, inherit, implement
});

/**
 * Files Table
 * Tracks files for incremental indexing
 * Only re-index files when content hash changes
 */
export const files = sqliteTable('files', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    filePath: text('file_path').notNull().unique(),
    contentHash: text('content_hash').notNull(),
    lastIndexedAt: text('last_indexed_at').notNull(),
});

/**
 * Meta Table
 * Stores project metadata and indexing state
 * (file hashes, last index time, etc.)
 */
export const meta = sqliteTable('meta', {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
});

// Type exports for use in the application
export type Symbol = typeof symbols.$inferSelect;
export type NewSymbol = typeof symbols.$inferInsert;
export type Edge = typeof edges.$inferSelect;
export type NewEdge = typeof edges.$inferInsert;
export type File = typeof files.$inferSelect;
export type NewFile = typeof files.$inferInsert;
export type Meta = typeof meta.$inferSelect;
export type NewMeta = typeof meta.$inferInsert;
