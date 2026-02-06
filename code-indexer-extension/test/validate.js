#!/usr/bin/env node

// Purpose: Simplified end-to-end validation script
// Tests the worker directly by spawning it as a child process

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

console.log('═══════════════════════════════════════════════════');
console.log('  Code Indexer Extension - Validation Script');
console.log('═══════════════════════════════════════════════════\n');

async function runValidation() {
    try {
        // Check if build exists
        const workerPath = path.join(__dirname, '..', 'dist', 'worker', 'worker.js');
        if (!fs.existsSync(workerPath)) {
            throw new Error(`Worker not found at: ${workerPath}\nPlease run 'npm run build' first.`);
        }

        console.log('✓ Build files found\n');

        // Read test file
        const testFilePath = path.join(__dirname, 'sample.ts');
        if (!fs.existsSync(testFilePath)) {
            throw new Error(`Test file not found: ${testFilePath}`);
        }

        const content = fs.readFileSync(testFilePath, 'utf-8');
        console.log(`Reading test file: ${testFilePath}`);
        console.log(`File size: ${content.length} characters\n`);

        // Start worker
        console.log('Starting worker...');
        const worker = new Worker(workerPath);

        let requestId = 0;
        const pendingRequests = new Map();

        // Helper to send request and wait for response
        function sendRequest(request) {
            return new Promise((resolve, reject) => {
                const id = `test-${requestId++}`;
                request.id = id;

                const timeout = setTimeout(() => {
                    pendingRequests.delete(id);
                    reject(new Error(`Request ${request.type} timed out`));
                }, 30000);

                pendingRequests.set(id, { resolve, reject, timeout });
                worker.postMessage(request);
            });
        }

        // Handle messages from worker
        worker.on('message', (message) => {
            if (message.type === 'ready') {
                console.log('✓ Worker ready\n');
                return;
            }

            const pending = pendingRequests.get(message.id);
            if (pending) {
                clearTimeout(pending.timeout);
                pendingRequests.delete(message.id);

                if (message.type === 'error') {
                    pending.reject(new Error(message.error));
                } else {
                    pending.resolve(message);
                }
            }
        });

        worker.on('error', (error) => {
            console.error('Worker error:', error);
            process.exit(1);
        });

        // Wait for ready signal
        await new Promise((resolve) => {
            const checkReady = (msg) => {
                if (msg.type === 'ready') {
                    worker.off('message', checkReady);
                    resolve();
                }
            };
            worker.on('message', checkReady);
        });

        // Parse the file
        console.log('Parsing test file...');
        const parseResponse = await sendRequest({
            type: 'parse',
            filePath: testFilePath,
            content: content,
            language: 'typescript',
        });

        console.log(`✓ Parsing complete`);
        console.log(`  - Symbols extracted: ${parseResponse.symbolCount}`);
        console.log(`  - Edges created: ${parseResponse.edgeCount}\n`);

        // Validate minimum symbol count
        if (parseResponse.symbolCount < 10) {
            throw new Error(
                `Expected at least 10 symbols, but got ${parseResponse.symbolCount}. ` +
                'Parser may not be working correctly.'
            );
        }

        // Query symbols by file
        console.log('Querying symbols by file...');
        const fileQueryResponse = await sendRequest({
            type: 'query-file',
            filePath: testFilePath,
        });

        console.log(`✓ Query successful: Found ${fileQueryResponse.symbols.length} symbols\n`);

        // Verify query results match parse results
        if (fileQueryResponse.symbols.length !== parseResponse.symbolCount) {
            throw new Error(
                `Symbol count mismatch: Parse returned ${parseResponse.symbolCount}, ` +
                `but query returned ${fileQueryResponse.symbols.length}`
            );
        }

        // Display sample symbols
        console.log('Sample symbols from database:');
        console.log('─────────────────────────────────────────────────');
        fileQueryResponse.symbols.slice(0, 10).forEach((symbol, index) => {
            console.log(
                `${(index + 1).toString().padStart(2)}. ${symbol.type.padEnd(12)} | ${symbol.name.padEnd(20)} | ` +
                `Line ${symbol.range.startLine}-${symbol.range.endLine} | ` +
                `Complexity: ${symbol.complexity}`
            );
        });
        console.log('─────────────────────────────────────────────────\n');

        // Query specific symbols
        console.log('Querying specific symbols...');
        const userServiceResponse = await sendRequest({
            type: 'query-symbols',
            query: 'UserService',
        });
        console.log(`✓ Query for "UserService": Found ${userServiceResponse.symbols.length} match(es)`);

        const factorialResponse = await sendRequest({
            type: 'query-symbols',
            query: 'factorial',
        });
        console.log(`✓ Query for "factorial": Found ${factorialResponse.symbols.length} match(es)\n`);

        // Get statistics
        console.log('Retrieving index statistics...');
        const statsResponse = await sendRequest({
            type: 'stats',
        });

        console.log('✓ Statistics retrieved:');
        console.log(`  - Total symbols: ${statsResponse.stats.symbolCount}`);
        console.log(`  - Total edges: ${statsResponse.stats.edgeCount}`);
        console.log(`  - Total files: ${statsResponse.stats.fileCount}`);
        if (statsResponse.stats.lastIndexTime) {
            console.log(`  - Last index time: ${statsResponse.stats.lastIndexTime}`);
        }
        console.log();

        // Verify symbol types
        const symbolTypes = new Set(fileQueryResponse.symbols.map((s) => s.type));
        console.log('Symbol types found:');
        Array.from(symbolTypes).forEach((type) => {
            const count = fileQueryResponse.symbols.filter((s) => s.type === type).length;
            console.log(`  - ${type}: ${count}`);
        });
        console.log();

        // Verify complexity calculation
        const complexSymbols = fileQueryResponse.symbols.filter((s) => s.complexity > 1);
        console.log(`Symbols with complexity > 1: ${complexSymbols.length}`);
        if (complexSymbols.length > 0) {
            console.log('Most complex symbols:');
            complexSymbols
                .sort((a, b) => b.complexity - a.complexity)
                .slice(0, 5)
                .forEach((symbol) => {
                    console.log(`  - ${symbol.name} (${symbol.type}): complexity ${symbol.complexity}`);
                });
        }
        console.log();

        // Test clear index
        console.log('Testing index clear...');
        await sendRequest({ type: 'clear' });
        const statsAfterClear = await sendRequest({ type: 'stats' });
        if (statsAfterClear.stats.symbolCount !== 0) {
            throw new Error('Index not properly cleared');
        }
        console.log('✓ Index cleared successfully\n');

        // Re-parse to restore data
        console.log('Re-parsing file to restore index...');
        await sendRequest({
            type: 'parse',
            filePath: testFilePath,
            content: content,
            language: 'typescript',
        });
        console.log('✓ Index restored\n');

        // Shutdown worker
        console.log('Shutting down worker...');
        // Don't wait for shutdown response - worker exits immediately
        worker.postMessage({ type: 'shutdown', id: 'shutdown' });

        // Wait a bit for graceful shutdown
        await new Promise(resolve => setTimeout(resolve, 500));

        // Force terminate if still running
        await worker.terminate();
        console.log('✓ Worker shutdown complete\n');

        // Success
        console.log('═══════════════════════════════════════════════════');
        console.log('  ✓ ALL VALIDATION TESTS PASSED');
        console.log('═══════════════════════════════════════════════════\n');

        process.exit(0);
    } catch (error) {
        console.error('\n✗ VALIDATION FAILED:');
        console.error(error.message);
        if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
        }
        console.log();
        process.exit(1);
    }
}

// Run validation
runValidation();
