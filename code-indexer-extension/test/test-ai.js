#!/usr/bin/env node

/**
 * Integration test for AI Orchestrator via Worker
 * Tests real API calls to Groq and Vertex AI
 */

const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

async function runAITest() {
    console.log('═══════════════════════════════════════════════════');
    console.log('  AI Orchestrator - Integration Test');
    console.log('═══════════════════════════════════════════════════\n');

    // Check for API keys
    const hasGroq = !!process.env.GROQ_API_KEY;
    const hasVertex = !!process.env.GOOGLE_CLOUD_PROJECT;

    if (!hasGroq) console.warn('⚠ GROQ_API_KEY not set. Groq tests will be skipped.');
    if (!hasVertex) console.warn('⚠ GOOGLE_CLOUD_PROJECT not set. Vertex AI tests will be skipped.');

    const workerPath = path.join(__dirname, '..', 'dist', 'worker', 'worker.js');
    if (!fs.existsSync(workerPath)) {
        console.error(`Worker not found at: ${workerPath}. Run 'npm run build' first.`);
        process.exit(1);
    }

    const worker = new Worker(workerPath);
    let requestId = 0;
    const pendingRequests = new Map();

    function sendRequest(request) {
        return new Promise((resolve, reject) => {
            const id = `ai-test-${requestId++}`;
            request.id = id;
            const timeout = setTimeout(() => {
                pendingRequests.delete(id);
                reject(new Error(`Request ${request.type} timed out`));
            }, 60000); // 60s timeout for AI
            pendingRequests.set(id, { resolve, reject, timeout });
            worker.postMessage(request);
        });
    }

    worker.on('message', (message) => {
        if (message.type === 'ready') return;
        const pending = pendingRequests.get(message.id);
        if (pending) {
            clearTimeout(pending.timeout);
            pendingRequests.delete(message.id);
            if (message.type === 'error') pending.reject(new Error(message.error));
            else pending.resolve(message);
        }
    });

    // Wait for ready
    await new Promise(resolve => {
        const onReady = (msg) => {
            if (msg.type === 'ready') {
                worker.off('message', onReady);
                resolve();
            }
        };
        worker.on('message', onReady);
    });

    console.log('✓ Worker ready\n');

    // 1. Index sample project
    console.log('Indexing validation project...');
    const validationDir = path.join(__dirname, 'validation-project');
    const files = ['fileA.ts', 'fileB.ts', 'fileC.ts'].map(f => ({
        filePath: path.join(validationDir, f),
        content: fs.readFileSync(path.join(validationDir, f), 'utf-8'),
        language: 'typescript'
    }));

    await sendRequest({ type: 'parse-batch', files });
    console.log('✓ Project indexed\n');

    // Find a symbol ID (Calculator in fileB)
    const queryResponse = await sendRequest({ type: 'query-symbols', query: 'Calculator' });
    const calculator = queryResponse.symbols.find(s => s.name === 'Calculator');

    if (!calculator) {
        console.error('Calculator symbol not found!');
        process.exit(1);
    }
    console.log(`Found Calculator symbol (ID: ${calculator.id})\n`);

    // 2. Test Intent Classification
    console.log('Testing Intent Classification...');
    const intentRes = await sendRequest({
        type: 'ai-classify-intent',
        query: 'Explain this Calculator class'
    });
    console.log(`  - Query: "Explain this Calculator class"`);
    console.log(`  - Result: ${intentRes.intentType} (confidence: ${intentRes.confidence})\n`);

    // 3. Test Reflex Path (Groq)
    if (hasGroq) {
        console.log('Testing Reflex Path (Groq/Llama 3.1)...');
        try {
            const groqRes = await sendRequest({
                type: 'ai-query',
                query: 'What does this Calculator class do?',
                symbolId: calculator.id
            });
            console.log(`  - Model: ${groqRes.model}`);
            console.log(`  - Latency: ${groqRes.latencyMs}ms`);
            console.log(`  - Content snippet: "${groqRes.content.substring(0, 100)}..."`);
            console.log(groqRes.latencyMs <= 300 ? '  ✓ Latency target (<300ms) met' : '  ⚠ Latency target exceeded');
            console.log('');
        } catch (e) {
            console.error('  ✗ Groq test failed:', e.message);
        }
    }

    // 4. Test Strategic Path (Vertex AI)
    if (hasVertex) {
        console.log('Testing Strategic Path (Vertex AI/Gemini 1.5 Pro)...');
        try {
            const vertexRes = await sendRequest({
                type: 'ai-query',
                query: 'Audit this Calculator implementation for security and structural issues.',
                symbolId: calculator.id,
                analysisType: 'security'
            });
            console.log(`  - Model: ${vertexRes.model}`);
            console.log(`  - Latency: ${vertexRes.latencyMs}ms`);
            console.log(`  - Context symbols: ${vertexRes.neighborCount} neighbors included`);
            console.log(`  - Content snippet: "${vertexRes.content.substring(0, 100)}..."`);
            console.log('');
        } catch (e) {
            console.error('  ✗ Vertex AI test failed:', e.message);
        }
    }

    // 5. Test MCP Tools
    console.log('Testing MCP Tool: get_dependencies...');
    const mcpRes = await sendRequest({
        type: 'mcp-tool-call',
        toolName: 'get_dependencies',
        arguments: { symbolId: calculator.id, direction: 'both' }
    });
    console.log(`  - Success: ${mcpRes.success}`);
    if (mcpRes.success) {
        console.log(`  - Outgoing deps: ${mcpRes.result.outgoing.length}`);
        console.log(`  - Incoming deps: ${mcpRes.result.incoming.length}`);
    }
    console.log('\n✓ MCP tool test complete');

    console.log('\nShutting down worker...');
    worker.postMessage({ type: 'shutdown' });
    setTimeout(() => worker.terminate(), 1000);
}

runAITest().catch(console.error);
