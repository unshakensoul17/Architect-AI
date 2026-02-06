# Code Indexer Extension

A VS Code extension that indexes your codebase using tree-sitter for fast, language-aware parsing and stores symbols in a SQLite database.

## Features

- **Fast AST Parsing**: Uses tree-sitter WASM for TypeScript, Python, and C
- **Background Processing**: All CPU-intensive work happens in a worker thread
- **SQLite Storage**: Symbols and relationships stored in embedded database
- **Complexity Metrics**: Calculates cyclomatic complexity for each symbol
- **Graph-Based Schema**: Represents code as nodes (symbols) and edges (relationships)

## Architecture

The extension follows a strict separation between UI and compute:

- **Main Thread**: Handles VS Code UI, commands, and event orchestration
- **Worker Thread**: Performs all parsing, AST traversal, and database operations
- **Message Protocol**: Typed communication between threads via MessagePort
- **Database**: better-sqlite3 with Drizzle ORM for type-safe queries

## Commands

- `Code Indexer: Index Workspace` - Index all supported files in workspace
- `Code Indexer: Query Symbols` - Search for symbols by name
- `Code Indexer: Clear Index` - Clear the entire index

## Supported Languages

- TypeScript (`.ts`, `.tsx`)
- Python (`.py`)
- C (`.c`, `.h`)

## Database Schema

### Symbols Table
Stores all code symbols (functions, classes, variables, etc.)

```sql
- id: integer (primary key)
- name: text
- type: text (function, class, variable, etc.)
- file_path: text
- range_start_line, range_start_column: integer
- range_end_line, range_end_column: integer
- complexity: integer
```

### Edges Table
Stores relationships between symbols

```sql
- id: integer (primary key)
- source_id: integer (foreign key → symbols.id)
- target_id: integer (foreign key → symbols.id)
- type: text (import, call, inherit)
```

### Meta Table
Stores indexing metadata

```sql
- key: text (primary key)
- value: text
```

## Development

### Setup

```bash
npm install
```

### Build

```bash
npm run build
```

### Validation

Run the validation script to test parsing and database operations:

```bash
npm run validate
```

This will:
1. Parse a 100-line TypeScript test file
2. Extract symbols and relationships
3. Store them in the database
4. Query and verify correctness
5. Display detailed statistics

### Watch Mode

```bash
npm run watch
```

## Testing in VS Code

1. Open this folder in VS Code
2. Press F5 to launch Extension Development Host
3. Run commands from Command Palette (Ctrl+Shift+P)

## Design Principles

- **Worker-Only Processing**: All parsing and DB writes happen in worker thread
- **Typed Messages**: Strict message protocol prevents runtime errors
- **Transaction Support**: Bulk inserts use transactions for performance
- **Incremental Indexing**: File hashing enables smart re-indexing
- **Complexity Metrics**: Local computation avoids external API costs

## License

MIT
