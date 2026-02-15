import * as vscode from 'vscode';

export class SidebarProvider implements vscode.WebviewViewProvider {
    _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
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
            }
        });
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        const styleResetUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'resources', 'reset.css')
        );
        const styleVSCodeUri = webview.asWebviewUri(
            vscode.Uri.joinPath(this._extensionUri, 'resources', 'vscode.css')
        );

        return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">
				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<title>Architect AI</title>
                <style>
                    body {
                        padding: 10px;
                        font-family: var(--vscode-font-family);
                        color: var(--vscode-foreground);
                    }
                    .button {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        padding: 8px 12px;
                        text-align: center;
                        text-decoration: none;
                        display: block;
                        font-size: 13px;
                        margin: 10px 0;
                        cursor: pointer;
                        width: 100%;
                        border-radius: 2px;
                    }
                    .button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    h2 {
                        font-size: 14px;
                        margin-bottom: 10px;
                        font-weight: 600;
                    }
                    p {
                        font-size: 13px;
                        opacity: 0.8;
                        margin-bottom: 15px;
                    }
                </style>
			</head>
			<body>
                <h2>Architect AI</h2>
                <p>Visualize and analyze your codebase architecture.</p>
				<button class="button" onclick="openGraph()">Open Architecture Graph</button>

                <script>
                    const vscode = acquireVsCodeApi();
                    function openGraph() {
                        vscode.postMessage({ type: 'open-graph' });
                    }
                </script>
			</body>
			</html>`;
    }
}
