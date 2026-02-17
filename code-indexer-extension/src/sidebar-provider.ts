import * as vscode from 'vscode';

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'open-graph': {
                    vscode.commands.executeCommand('codeIndexer.visualizeGraph');
                    break;
                }
                case 'update-index': {
                    vscode.commands.executeCommand('codeIndexer.indexWorkspace');
                    break;
                }
                case 'reset-index': {
                    vscode.commands.executeCommand('codeIndexer.clearIndex');
                    break;
                }
                case 'update-api-keys': {
                    vscode.commands.executeCommand('codeIndexer.configureAI');
                    break;
                }
            }
        });
    }

    private _getHtmlForWebview(_webview: vscode.Webview) {
        // Use VS Code's native CSS variables for a consistent look
        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Architect AI</title>
                <style>
                    :root {
                        --container-padding: 16px;
                    }
                    body {
                        padding: var(--container-padding);
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                        background-color: var(--vscode-sideBar-background);
                        display: flex;
                        flex-direction: column;
                        gap: 16px;
                    }
                    
                    .header {
                        display: flex;
                        flex-direction: column;
                        gap: 8px;
                        margin-bottom: 8px;
                    }

                    h2 {
                        font-size: 11px;
                        text-transform: uppercase;
                        letter-spacing: 0.5px;
                        color: var(--vscode-descriptionForeground);
                        margin: 0;
                        font-weight: 600;
                    }

                    .card {
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-widget-border);
                        border-radius: 6px;
                        padding: 12px;
                        display: flex;
                        flex-direction: column;
                        gap: 12px;
                    }

                    .hero-button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 10px 14px;
                        text-align: center;
                        text-decoration: none;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        font-size: 13px;
                        font-weight: 500;
                        cursor: pointer;
                        border-radius: 4px;
                        transition: background-color 0.1s;
                        width: 100%;
                        box-sizing: border-box;
                    }
                    
                    .hero-button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }

                    .secondary-button {
                        background-color: var(--vscode-button-secondaryBackground);
                        color: var(--vscode-button-secondaryForeground);
                        border: none;
                        padding: 8px 12px;
                        text-align: left;
                        text-decoration: none;
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        font-size: 12px;
                        cursor: pointer;
                        border-radius: 4px;
                        transition: background-color 0.1s;
                        width: 100%;
                        box-sizing: border-box;
                    }

                    .secondary-button:hover {
                        background-color: var(--vscode-button-secondaryHoverBackground);
                    }

                    .icon {
                        width: 14px;
                        height: 14px;
                        fill: currentColor;
                        opacity: 0.8;
                    }

                    .divider {
                        height: 1px;
                        background-color: var(--vscode-widget-border);
                        margin: 4px 0;
                        opacity: 0.5;
                    }

                    .status-text {
                        font-size: 11px;
                        color: var(--vscode-descriptionForeground);
                        text-align: center;
                        opacity: 0.8;
                    }
                </style>
			</head>
			<body>
                <div class="header">
                    <h2>Architect AI</h2>
                </div>

                <div class="card">
                    <button class="hero-button" onclick="sendMessage('open-graph')">
                        <span style="margin-right: 8px;">📊</span> Open Architecture Graph
                    </button>
                    <div class="status-text">Visualize codebase structure & flows</div>
                </div>

                <div class="header" style="margin-top: 12px;">
                    <h2>Workspace & AI</h2>
                </div>

                <div class="card" style="gap: 8px;">
                    <button class="secondary-button" onclick="sendMessage('update-index')">
                        <span style="font-size: 14px;">🔄</span> Update Workspace Index
                    </button>
                    
                    <button class="secondary-button" onclick="sendMessage('update-api-keys')">
                        <span style="font-size: 14px;">🔑</span> Update API Keys
                    </button>

                    <div class="divider"></div>

                    <button class="secondary-button" onclick="sendMessage('reset-index')" style="color: var(--vscode-errorForeground);">
                        <span style="font-size: 14px;">🗑️</span> Reset Workspace Index
                    </button>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    function sendMessage(type) {
                        vscode.postMessage({ type: type });
                    }
                </script>
			</body>
			</html>`;
    }
}
