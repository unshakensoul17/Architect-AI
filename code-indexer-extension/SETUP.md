# Setup Instructions

## Known Issue: better-sqlite3 with Node.js v24

The `better-sqlite3` package has compatibility issues with Node.js v24. There are two solutions:

### Solution 1: Use Node.js v20 or v22 (Recommended)

```bash
# If using nvm
nvm install 20
nvm use 20
cd /home/unshakensoul/Documents/Projects\ and\ Notes/Projects/Architect\ AI/code-indexer-extension
npm install
npm run build
```

### Solution 2: Use pre-built binaries

```bash
npm install better-sqlite3 --save-optional
```

## Full Setup Steps

1. **Switch to Node.js v20**:
   ```bash
   nvm use 20  # or nvm install 20 && nvm use 20
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the extension**:
   ```bash
   npm run build
   ```

4. **Run validation tests**:
   ```bash
   npm run validate
   ```

5. **Test in VS Code**:
   - Open the extension folder in VS Code
   - Press F5 to launch Extension Development Host
   - Run "Code Indexer: Index Workspace" from Command Palette

## Alternative: SQL.js (Pure JavaScript)

If better-sqlite3 continues to fail, the project can be migrated to use sql.js (fully JavaScript implementation):

```bash
npm uninstall better-sqlite3
npm install sql.js
```

Then update `src/db/database.ts` to use sql.js instead.

## Current Status

All source files are complete and ready:
- ✓ Extension entry point (`src/extension.ts`)
- ✓ Worker thread implementation (`src/worker/worker.ts`)
- ✓ Worker manager (`src/worker/worker-manager.ts`)
- ✓ Tree-sitter parser (`src/worker/parser.ts`)
- ✓ Symbol extractor (`src/worker/symbol-extractor.ts`)
- ✓ Database layer (`src/db/database.ts`, `src/db/schema.ts`)
- ✓ Message protocol (`src/worker/message-protocol.ts`)
- ✓ Test file (`test/sample.ts`)
- ✓ Validation script (`test/validate.js`)
- ✓ Configuration files (package.json, tsconfig.json, etc.)

Only the `better-sqlite3` compilation needs to be resolved by using Node.js v20.
