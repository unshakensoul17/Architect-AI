import * as vscode from 'vscode';
import * as path from 'path';
import type { WorkerManager } from './worker/worker-manager';

export class GraphWebviewProvider {
    private panel: vscode.WebviewPanel | undefined;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly context: vscode.ExtensionContext,
        private readonly workerManager: WorkerManager
    ) { }

    public async show() {
        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.One);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'codeGraphVisualization',
            'Code Graph Visualization',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview'))
                ],
            }
        );

        this.panel.webview.html = this.getHtmlContent(this.panel.webview);

        // Handle messages from webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.type) {
                    case 'ready':
                        console.log('Webview ready');
                        break;

                    case 'request-graph':
                        await this.sendGraphData();
                        break;

                    case 'node-selected':
                        await this.handleNodeSelected(message.nodeId);
                        break;

                    case 'export-image':
                        vscode.window.showInformationMessage(
                            `Export as ${message.format} - Feature coming soon!`
                        );
                        break;

                    // Inspector Panel message handlers
                    case 'inspector-overview':
                    case 'inspector-dependencies':
                    case 'inspector-risks':
                    case 'inspector-ai-action':
                    case 'inspector-ai-why':
                        await this.handleInspectorMessage(message);
                        break;

                    case 'preview-refactor':
                        await this.handlePreviewRefactor(message.diff);
                        break;

                    case 'apply-refactor':
                        await this.handleApplyRefactor(message.diff);
                        break;

                    case 'cancel-refactor':
                        // Just acknowledge cancellation
                        break;
                }
            },
            null,
            this.disposables
        );

        // Handle panel disposal
        this.panel.onDidDispose(
            () => {
                this.panel = undefined;
                this.disposables.forEach((d) => d.dispose());
                this.disposables = [];
            },
            null,
            this.disposables
        );

        // Send initial graph data
        await this.sendGraphData();
    }

    private async sendGraphData() {
        if (!this.panel) {
            return;
        }

        try {
            // Export graph from worker
            const graphData = await this.workerManager.exportGraph();
            console.log(`Sending graph data to webview: ${graphData.symbols.length} symbols, ${graphData.edges.length} edges`);

            // Send to webview
            this.panel.webview.postMessage({
                type: 'graph-data',
                data: graphData,
            });
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to load graph data: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private async handleNodeSelected(nodeId: string) {
        // Parse node ID: "filePath:symbolName:line"
        const parts = nodeId.split(':');
        if (parts.length < 3) {
            return;
        }

        const filePath = parts[0];
        const line = parseInt(parts[2], 10);

        try {
            const uri = vscode.Uri.file(filePath);
            const document = await vscode.workspace.openTextDocument(uri);
            const editor = await vscode.window.showTextDocument(document, {
                viewColumn: vscode.ViewColumn.Two,
                preserveFocus: false,
            });

            // Jump to line
            const position = new vscode.Position(Math.max(0, line - 1), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(
                new vscode.Range(position, position),
                vscode.TextEditorRevealType.InCenter
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to open file: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Handle inspector panel messages by forwarding to worker
     * and sending results back to webview
     */
    private async handleInspectorMessage(message: {
        type: string;
        requestId: string;
        nodeId: string;
        nodeType?: 'domain' | 'file' | 'symbol';
        action?: string;
        metric?: string;
    }): Promise<void> {
        if (!this.panel) return;

        const messageId = `inspector-${Date.now()}`;

        try {
            // Forward to worker and wait for response
            const response = await this.workerManager.sendInspectorRequest({
                type: message.type as any,
                id: messageId,
                requestId: message.requestId,
                nodeId: message.nodeId,
                nodeType: message.nodeType,
                action: message.action,
                metric: message.metric,
            });

            // Send response back to webview
            this.panel.webview.postMessage({
                ...response,
                requestId: message.requestId,
            });
        } catch (error) {
            // Send error back to webview
            this.panel.webview.postMessage({
                type: `${message.type}-error`,
                requestId: message.requestId,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Preview refactor changes in VS Code diff view
     */
    private async handlePreviewRefactor(message: { diff: string }): Promise<void> {
        try {
            // Open a new document with the diff content
            const doc = await vscode.workspace.openTextDocument({
                content: message.diff,
                language: 'diff'
            });
            await vscode.window.showTextDocument(doc);
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to preview refactor: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    /**
     * Apply refactor changes to actual files
     */
    private async handleApplyRefactor(message: { diff: string }): Promise<void> {
        try {
            const confirm = await vscode.window.showWarningMessage(
                'Apply refactor changes? This will modify your files.',
                { modal: true },
                'Apply'
            );

            if (confirm !== 'Apply') {
                return;
            }

            // TODO: Implement actual diff application
            vscode.window.showInformationMessage('Refactor application not yet implemented');
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to apply refactor: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }

    private getHtmlContent(webview: vscode.Webview): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'index.js'))
        );
        const styleUri = webview.asWebviewUri(
            vscode.Uri.file(path.join(this.context.extensionPath, 'dist', 'webview', 'index.css'))
        );

        // Get nonce for CSP
        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
    <link href="${styleUri}" rel="stylesheet">
    <title>Code Graph Visualization</title>
    <style>
        body, html, #root {
            margin: 0;
            padding: 0;
            width: 100%;
            height: 100%;
            overflow: hidden;
        }
    </style>
</head>
<body>
    <div id="root"></div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }

    public dispose() {
        if (this.panel) {
            this.panel.dispose();
        }
        this.disposables.forEach((d) => d.dispose());
    }
}

function getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
