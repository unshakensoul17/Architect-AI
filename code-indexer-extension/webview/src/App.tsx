import { useState, useEffect, useCallback } from 'react';
import GraphCanvas from './components/GraphCanvas';
import type { GraphData, VSCodeAPI, ExtensionMessage, WebviewMessage } from './types';
import { PerformanceMonitor } from './utils/performance';

// Get VS Code API
const vscode: VSCodeAPI = window.acquireVsCodeApi();

function App() {
    const [graphData, setGraphData] = useState<GraphData | null>(null);
    const [fps, setFps] = useState<number>(60);
    const [loading, setLoading] = useState(true);

    // Performance monitoring
    useEffect(() => {
        const monitor = new PerformanceMonitor();
        monitor.start((currentFps) => {
            setFps(currentFps);
        });
    }, []);

    // Message handler from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;

            switch (message.type) {
                case 'graph-data':
                    setGraphData(message.data);
                    setLoading(false);
                    break;

                case 'theme-changed':
                    // Theme changes are handled by CSS variables
                    break;
            }
        };

        window.addEventListener('message', handleMessage);

        // Request graph data on mount
        const readyMessage: WebviewMessage = { type: 'ready' };
        vscode.postMessage(readyMessage);

        const requestMessage: WebviewMessage = { type: 'request-graph' };
        vscode.postMessage(requestMessage);

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, []);

    const handleNodeClick = useCallback((nodeId: string) => {
        const message: WebviewMessage = {
            type: 'node-selected',
            nodeId,
        };
        vscode.postMessage(message);
    }, []);

    const handleExport = useCallback((format: 'png' | 'svg') => {
        const message: WebviewMessage = {
            type: 'export-image',
            format,
        };
        vscode.postMessage(message);
    }, []);

    const handleRefresh = useCallback(() => {
        setLoading(true);
        const message: WebviewMessage = { type: 'request-graph' };
        vscode.postMessage(message);
    }, []);

    return (
        <div className="w-full h-full flex flex-col">
            {/* Toolbar */}
            <div
                className="flex items-center justify-between px-4 py-2 border-b"
                style={{
                    backgroundColor: 'var(--vscode-sideBar-background)',
                    borderColor: 'var(--vscode-panel-border)',
                }}
            >
                <div className="flex items-center gap-4">
                    <h1 className="text-lg font-bold">Code Graph Visualization</h1>
                    {graphData && (
                        <div className="text-xs opacity-70">
                            {graphData.symbols.length} symbols · {graphData.edges.length} edges
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* FPS Counter */}
                    <div
                        className="text-xs px-2 py-1 rounded"
                        style={{
                            backgroundColor:
                                fps >= 55
                                    ? '#10b98150'
                                    : fps >= 30
                                        ? '#fbbf2450'
                                        : '#ef444450',
                            color: fps >= 55 ? '#10b981' : fps >= 30 ? '#fbbf24' : '#ef4444',
                        }}
                        title="Frames per second"
                    >
                        {fps} FPS
                    </div>

                    {/* Refresh Button */}
                    <button
                        onClick={handleRefresh}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: 'var(--vscode-button-background)',
                            color: 'var(--vscode-button-foreground)',
                        }}
                        disabled={loading}
                    >
                        {loading ? 'Loading...' : 'Refresh'}
                    </button>

                    {/* Export Buttons */}
                    <button
                        onClick={() => handleExport('png')}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: 'var(--vscode-button-secondaryBackground)',
                            color: 'var(--vscode-button-secondaryForeground)',
                        }}
                        disabled={!graphData}
                    >
                        Export PNG
                    </button>
                </div>
            </div>

            {/* Legend */}
            {graphData && (
                <div
                    className="flex items-center gap-4 px-4 py-2 text-xs border-b"
                    style={{
                        backgroundColor: 'var(--vscode-sideBar-background)',
                        borderColor: 'var(--vscode-panel-border)',
                    }}
                >
                    <div className="font-semibold">Coupling Heatmap:</div>
                    <div className="flex items-center gap-2">
                        <div
                            className="w-4 h-4 rounded"
                            style={{ backgroundColor: '#3b82f6' }}
                        />
                        <span>Low</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div
                            className="w-4 h-4 rounded"
                            style={{ backgroundColor: '#fbbf24' }}
                        />
                        <span>Medium</span>
                    </div>
                    <div className="flex items-center gap-2">
                        <div
                            className="w-4 h-4 rounded"
                            style={{ backgroundColor: '#ef4444' }}
                        />
                        <span>High</span>
                    </div>
                </div>
            )}

            {/* Graph Canvas */}
            <div className="flex-1">
                {loading ? (
                    <div className="flex items-center justify-center w-full h-full">
                        <div className="text-center">
                            <div className="text-lg font-semibold mb-2">Loading Graph...</div>
                            <div className="text-sm opacity-70">
                                Calculating coupling metrics and layout
                            </div>
                        </div>
                    </div>
                ) : (
                    <GraphCanvas graphData={graphData} onNodeClick={handleNodeClick} />
                )}
            </div>
        </div>
    );
}

export default App;
