const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');

const WORKER_PATH = path.join(__dirname, '../dist/worker/worker.js');

async function runStressTest() {
    console.log('Starting Architect.ai Worker Stress Test...');

    // Create worker
    const worker = new Worker(WORKER_PATH);

    let isReady = false;
    let requestCount = 0;
    const startTime = Date.now();

    // Generate dummy files
    const FILE_COUNT = 1000;
    const files = [];
    for (let i = 0; i < FILE_COUNT; i++) {
        files.push({
            filePath: `/tmp/test-project/file_${i}.ts`,
            content: `
                export class Class${i} {
                    constructor(private value: number) {}
                    
                    methodA() {
                        return this.value * 2;
                    }

                    methodB() {
                        return this.methodA() + 10;
                    }
                }

                export function helper${i}() {
                    const c = new Class${i}(100);
                    return c.methodB();
                }
            `,
            language: 'typescript'
        });
    }

    console.log(`Generated ${FILE_COUNT} files for testing.`);

    worker.on('message', (message) => {
        if (message.type === 'ready') {
            console.log('Worker is ready. Sending initial batch...');
            isReady = true;

            // Send batch
            worker.postMessage({
                id: 'stress-test-1',
                type: 'parse-batch',
                files: files
            });

        } else if (message.type === 'parse-batch-complete') {
            console.log(`Batch complete! Processed ${message.filesProcessed} files.`);
            console.log(`Symbols: ${message.totalSymbols}, Edges: ${message.totalEdges}`);
            const duration = (Date.now() - startTime) / 1000;
            console.log(`Duration: ${duration.toFixed(2)}s`);
            console.log(`Throughput: ${(FILE_COUNT / duration).toFixed(2)} files/s`);
            process.exit(0);
        } else if (message.type === 'error') {
            console.error('Worker returned error:', message.error);
        }
    });

    worker.on('error', (err) => {
        console.error('Worker error:', err);
        process.exit(1);
    });

    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Worker exited with code ${code}`);
            process.exit(code);
        }
    });

    // Monitor memory
    setInterval(() => {
        // We can't easily get worker memory from parent without message, 
        // but we can assume if it doesn't crash it's fine.
        // Real memory monitoring would require the worker to send stats.
        process.stdout.write('.');
    }, 1000);
}

runStressTest();
