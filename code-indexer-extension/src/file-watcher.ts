// Purpose: File system watcher for incremental indexing
// Monitors workspace files and triggers re-indexing only when content changes
// Uses content hashing to avoid unnecessary re-parsing

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { WorkerManager } from './worker/worker-manager';

export class FileWatcherManager {
    private watcher: vscode.FileSystemWatcher | null = null;
    private workerManager: WorkerManager;
    private outputChannel: vscode.OutputChannel;
    private isEnabled: boolean = false;
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly DEBOUNCE_MS = 500;

    constructor(workerManager: WorkerManager, outputChannel: vscode.OutputChannel) {
        this.workerManager = workerManager;
        this.outputChannel = outputChannel;
    }

    /**
     * Start watching for file changes
     */
    start(): void {
        if (this.watcher) {
            return;
        }

        // Watch TypeScript, Python, and C files
        this.watcher = vscode.workspace.createFileSystemWatcher(
            '**/*.{ts,tsx,py,c,h}',
            false, // Don't ignore creates
            false, // Don't ignore changes
            false  // Don't ignore deletes
        );

        // Handle file changes
        this.watcher.onDidChange(async (uri) => {
            this.debounceReindex(uri);
        });

        // Handle new files
        this.watcher.onDidCreate(async (uri) => {
            this.debounceReindex(uri);
        });

        // Handle deleted files
        this.watcher.onDidDelete(async (uri) => {
            await this.handleFileDelete(uri);
        });

        this.isEnabled = true;
        this.outputChannel.appendLine('File watcher started');
    }

    /**
     * Stop watching files
     */
    stop(): void {
        if (this.watcher) {
            this.watcher.dispose();
            this.watcher = null;
        }

        // Clear any pending debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();

        this.isEnabled = false;
        this.outputChannel.appendLine('File watcher stopped');
    }

    /**
     * Debounce file change events to avoid rapid re-indexing
     */
    private debounceReindex(uri: vscode.Uri): void {
        const filePath = uri.fsPath;

        // Clear existing timer for this file
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }

        // Set new debounced timer
        const timer = setTimeout(async () => {
            this.debounceTimers.delete(filePath);
            await this.handleFileChange(uri);
        }, this.DEBOUNCE_MS);

        this.debounceTimers.set(filePath, timer);
    }

    /**
     * Handle file change event
     */
    private async handleFileChange(uri: vscode.Uri): Promise<void> {
        const filePath = uri.fsPath;

        // Skip if in node_modules or other excluded paths
        if (this.shouldSkipFile(filePath)) {
            return;
        }

        try {
            // Read file content
            const document = await vscode.workspace.openTextDocument(uri);
            const content = document.getText();

            // Check if file needs re-indexing
            const needsReindex = await this.workerManager.checkFileHash(filePath, content);

            if (!needsReindex) {
                this.outputChannel.appendLine(`Skipping unchanged file: ${filePath}`);
                return;
            }

            // Determine language
            const language = this.getLanguage(filePath);
            if (!language) {
                return;
            }

            // Re-index the file
            this.outputChannel.appendLine(`Re-indexing changed file: ${filePath}`);
            const result = await this.workerManager.parseFile(filePath, content, language);
            this.outputChannel.appendLine(
                `Re-indexed ${filePath}: ${result.symbolCount} symbols, ${result.edgeCount} edges`
            );
        } catch (error) {
            this.outputChannel.appendLine(`Error re-indexing ${filePath}: ${error}`);
        }
    }

    /**
     * Handle file deletion
     */
    private async handleFileDelete(uri: vscode.Uri): Promise<void> {
        const filePath = uri.fsPath;

        if (this.shouldSkipFile(filePath)) {
            return;
        }

        this.outputChannel.appendLine(`File deleted: ${filePath}`);
        // The file's symbols will be cleaned up on next full index
        // since we delete symbols by file before re-inserting
    }

    /**
     * Check if file should be skipped
     */
    private shouldSkipFile(filePath: string): boolean {
        const excludePatterns = [
            'node_modules',
            '.git',
            'venv',
            '.venv',
            'dist',
            'build',
            'out',
            '.vscode',
            '__pycache__',
            '.cache',
            '.pytest_cache',
            '.next',
            '.svelte-kit',
        ];

        return excludePatterns.some((pattern) => filePath.includes(pattern));
    }

    /**
     * Get language from file path
     */
    private getLanguage(filePath: string): 'typescript' | 'python' | 'c' | null {
        const ext = filePath.split('.').pop()?.toLowerCase();

        switch (ext) {
            case 'ts':
            case 'tsx':
                return 'typescript';
            case 'py':
                return 'python';
            case 'c':
            case 'h':
                return 'c';
            default:
                return null;
        }
    }

    /**
     * Compute content hash
     */
    static computeHash(content: string): string {
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    /**
     * Check if watcher is active
     */
    isActive(): boolean {
        return this.isEnabled;
    }
}
