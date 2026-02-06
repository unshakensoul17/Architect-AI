// Purpose: VS Code Extension entry point
// Handles extension activation, command registration, and orchestration
// Main thread focuses only on UI events and delegation

import * as vscode from 'vscode';
import * as path from 'path';
import { WorkerManager } from './worker/worker-manager';

let workerManager: WorkerManager | null = null;
let outputChannel: vscode.OutputChannel;

/**
 * Extension activation
 */
export async function activate(context: vscode.ExtensionContext) {
    outputChannel = vscode.window.createOutputChannel('Code Indexer');
    outputChannel.appendLine('Code Indexer extension activating...');

    // Initialize worker
    try {
        workerManager = new WorkerManager();
        const workerPath = path.join(context.extensionPath, 'dist', 'worker', 'worker.js');
        await workerManager.start(workerPath);
        outputChannel.appendLine('Worker initialized successfully');
    } catch (error) {
        outputChannel.appendLine(`Failed to initialize worker: ${error}`);
        vscode.window.showErrorMessage('Code Indexer: Failed to initialize worker');
        return;
    }

    // Register commands
    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.indexWorkspace', async () => {
            await indexWorkspace();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.querySymbols', async () => {
            await querySymbols();
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('codeIndexer.clearIndex', async () => {
            await clearIndex();
        })
    );

    outputChannel.appendLine('Code Indexer extension activated');
}

/**
 * Extension deactivation
 */
export async function deactivate() {
    if (workerManager) {
        await workerManager.shutdown();
    }

    if (outputChannel) {
        outputChannel.dispose();
    }
}

/**
 * Index workspace command
 */
async function indexWorkspace() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
        vscode.window.showWarningMessage('No workspace folder open');
        return;
    }

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: 'Indexing workspace...',
            cancellable: false,
        },
        async (progress) => {
            try {
                // Find all supported files
                const files = await vscode.workspace.findFiles(
                    '**/*.{ts,tsx,py,c,h}',
                    '**/node_modules/**'
                );

                let indexed = 0;
                let totalSymbols = 0;

                for (const file of files) {
                    progress.report({
                        message: `Indexing ${path.basename(file.fsPath)} (${indexed + 1}/${files.length})`,
                        increment: (100 / files.length),
                    });

                    try {
                        const document = await vscode.workspace.openTextDocument(file);
                        const content = document.getText();
                        const language = getLanguage(file.fsPath);

                        if (language) {
                            const result = await workerManager!.parseFile(file.fsPath, content, language);
                            totalSymbols += result.symbolCount;
                            outputChannel.appendLine(
                                `Indexed ${file.fsPath}: ${result.symbolCount} symbols, ${result.edgeCount} edges`
                            );
                        }
                    } catch (error) {
                        outputChannel.appendLine(`Error indexing ${file.fsPath}: ${error}`);
                    }

                    indexed++;
                }

                vscode.window.showInformationMessage(
                    `Indexed ${indexed} files with ${totalSymbols} symbols`
                );

                outputChannel.appendLine(`Indexing complete: ${indexed} files, ${totalSymbols} symbols`);
            } catch (error) {
                vscode.window.showErrorMessage(`Indexing failed: ${error}`);
                outputChannel.appendLine(`Indexing failed: ${error}`);
            }
        }
    );
}

/**
 * Query symbols command
 */
async function querySymbols() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    const query = await vscode.window.showInputBox({
        prompt: 'Enter symbol name to search',
        placeHolder: 'e.g., myFunction',
    });

    if (!query) {
        return;
    }

    try {
        const symbols = await workerManager.querySymbols(query);

        if (symbols.length === 0) {
            vscode.window.showInformationMessage(`No symbols found for "${query}"`);
            return;
        }

        // Create QuickPick items
        const items: vscode.QuickPickItem[] = symbols.map((symbol) => ({
            label: `$(symbol-${symbol.type}) ${symbol.name}`,
            description: `${symbol.type} • ${path.basename(symbol.filePath)}`,
            detail: `${symbol.filePath}:${symbol.range.startLine} (complexity: ${symbol.complexity})`,
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: `Found ${symbols.length} symbol(s)`,
        });

        if (selected) {
            // Extract file path from detail
            const symbolIndex = items.indexOf(selected);
            const symbol = symbols[symbolIndex];

            // Open file at symbol location
            const doc = await vscode.workspace.openTextDocument(symbol.filePath);
            const editor = await vscode.window.showTextDocument(doc);

            const position = new vscode.Position(symbol.range.startLine - 1, symbol.range.startColumn);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
        }
    } catch (error) {
        vscode.window.showErrorMessage(`Query failed: ${error}`);
        outputChannel.appendLine(`Query failed: ${error}`);
    }
}

/**
 * Clear index command
 */
async function clearIndex() {
    if (!workerManager) {
        vscode.window.showErrorMessage('Worker not initialized');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        'Are you sure you want to clear the code index?',
        'Yes',
        'No'
    );

    if (confirm === 'Yes') {
        try {
            await workerManager.clearIndex();
            vscode.window.showInformationMessage('Code index cleared');
            outputChannel.appendLine('Index cleared');
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to clear index: ${error}`);
            outputChannel.appendLine(`Failed to clear index: ${error}`);
        }
    }
}

/**
 * Determine language from file extension
 */
function getLanguage(filePath: string): 'typescript' | 'python' | 'c' | null {
    const ext = path.extname(filePath).toLowerCase();

    if (ext === '.ts' || ext === '.tsx') {
        return 'typescript';
    } else if (ext === '.py') {
        return 'python';
    } else if (ext === '.c' || ext === '.h') {
        return 'c';
    }

    return null;
}
