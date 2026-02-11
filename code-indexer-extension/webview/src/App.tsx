import { useState, useEffect, useCallback, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import GraphCanvas from './components/GraphCanvas';
import { InspectorPanel } from './components/inspector';
import { useInspectorStore } from './stores/useInspectorStore';
import type { GraphData, VSCodeAPI, ExtensionMessage, WebviewMessage } from './types';
import type { NodeType } from './types/inspector';
import { PerformanceMonitor } from './utils/performance';

// Get VS Code API
const vscode: VSCodeAPI = window.acquireVsCodeApi();

function App() {
    const [graphData, setGraphData] = useState<GraphData | null>(null);
    const [loading, setLoading] = useState(true);
    const [showInspector, setShowInspector] = useState(true);
    const [searchQuery, setSearchQuery] = useState('');
    const fpsRef = useRef<HTMLDivElement>(null);

    // Get stable action references from store
    const selectNode = useInspectorStore((s) => s.selectNode);

    // Ref to track last clicked node to prevent duplicate updates
    const lastClickedNodeRef = useRef<string | null>(null);

    // Performance monitoring — use direct DOM mutation to avoid React re-renders
    useEffect(() => {
        const monitor = new PerformanceMonitor();
        monitor.start((currentFps) => {
            if (fpsRef.current) {
                fpsRef.current.textContent = `${currentFps} FPS`;
                fpsRef.current.style.backgroundColor =
                    currentFps >= 55 ? '#10b98150' : currentFps >= 30 ? '#fbbf2450' : '#ef444450';
                fpsRef.current.style.color =
                    currentFps >= 55 ? '#10b981' : currentFps >= 30 ? '#fbbf24' : '#ef4444';
            }
        });
        return () => monitor.stop();
    }, []);

    // Message handler from extension
    useEffect(() => {
        const handleMessage = (event: MessageEvent<ExtensionMessage>) => {
            const message = event.data;

            switch (message.type) {
                case 'graph-data':
                    if (message.data) {
                        setGraphData(message.data);
                        (window as any).graphData = message.data;
                        setLoading(false);
                    }
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

    // Determine node type from node ID pattern
    const getNodeType = useCallback((nodeId: string): NodeType => {
        if (nodeId.startsWith('domain:')) {
            return 'domain';
        }
        // File nodes have format: domain:filePath (no symbol/line at end)
        // Symbol nodes have format: filePath:symbolName:line
        const parts = nodeId.split(':');
        if (parts.length >= 3 && /^\d+$/.test(parts[parts.length - 1])) {
            return 'symbol';
        }
        return 'file';
    }, []);

    const handleNodeClick = useCallback(
        (nodeId: string) => {
            // Prevent duplicate updates for same node
            if (lastClickedNodeRef.current === nodeId) {
                return;
            }
            lastClickedNodeRef.current = nodeId;

            // Determine node type and update inspector store
            const nodeType = getNodeType(nodeId);
            selectNode(nodeId, nodeType);

            // Show inspector panel if hidden
            setShowInspector(true);

            // Notify extension
            const message: WebviewMessage = {
                type: 'node-selected',
                nodeId,
            };
            vscode.postMessage(message);
        },
        [selectNode, getNodeType]
    );

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

    const handleCloseInspector = useCallback(() => {
        setShowInspector(false);
    }, []);

    const handleFocusNode = useCallback(
        (nodeId: string) => {
            // Update inspector selection
            const nodeType = getNodeType(nodeId);
            selectNode(nodeId, nodeType);

            // Also trigger a click to focus the graph
            // The GraphCanvas should handle the actual focusing
            handleNodeClick(nodeId);
        },
        [getNodeType, selectNode, handleNodeClick]
    );

    const handleToggleInspector = useCallback(() => {
        setShowInspector((prev) => !prev);
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
                    <input
                        type="text"
                        placeholder="Search symbols or AI tags..."
                        className="px-2 py-1 text-sm rounded ml-4"
                        style={{
                            background: 'var(--vscode-input-background)',
                            color: 'var(--vscode-input-foreground)',
                            border: '1px solid var(--vscode-input-border)',
                            minWidth: '250px',
                        }}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />
                    {graphData && (
                        <div className="text-xs opacity-70">
                            {graphData.domains.length} domains · {graphData.symbols.length} symbols ·{' '}
                            {graphData.edges.length} edges
                        </div>
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* FPS Counter — uses ref for direct DOM updates */}
                    <div
                        ref={fpsRef}
                        className="text-xs px-2 py-1 rounded"
                        style={{
                            backgroundColor: '#10b98150',
                            color: '#10b981',
                        }}
                        title="Frames per second"
                    >
                        60 FPS
                    </div>

                    {/* Inspector Toggle */}
                    <button
                        onClick={handleToggleInspector}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: showInspector
                                ? 'var(--vscode-button-background)'
                                : 'var(--vscode-button-secondaryBackground)',
                            color: showInspector
                                ? 'var(--vscode-button-foreground)'
                                : 'var(--vscode-button-secondaryForeground)',
                        }}
                        title={showInspector ? 'Hide Inspector' : 'Show Inspector'}
                    >
                        📋
                    </button>

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

                    {/* Export Button */}
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

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Graph Canvas */}
                <div className="flex-1 overflow-hidden">
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
                        <ReactFlowProvider>
                            <GraphCanvas
                                graphData={graphData}
                                vscode={vscode}
                                onNodeClick={handleNodeClick}
                                searchQuery={searchQuery}
                            />
                        </ReactFlowProvider>
                    )}
                </div>

                {/* Inspector Panel */}
                {showInspector && (
                    <InspectorPanel
                        vscode={vscode}
                        onClose={handleCloseInspector}
                        onFocusNode={handleFocusNode}
                    />
                )}
            </div>
        </div>
    );
}

export default App;
