import { useState, useEffect, useCallback, useRef } from 'react';
import { ReactFlowProvider } from '@xyflow/react';
import GraphCanvas from './components/GraphCanvas';
import { InspectorPanel } from './components/inspector';
import { useInspectorStore } from './stores/useInspectorStore';
import { useGraphStore } from './stores/useGraphStore';
import type { GraphData, VSCodeAPI, ExtensionMessage, WebviewMessage } from './types';
import type { NodeType } from './types/inspector';
import { PerformanceMonitor } from './utils/performance';

// Get VS Code API
const vscode: VSCodeAPI = window.acquireVsCodeApi();

function App() {
    const {
        displayedGraphData,
        originalGraphData,
        isLoading,
        setGraphData,
        setArchitectureSkeleton,
        setFunctionTrace,
        setViewMode,
        filterByDirectory,
        viewMode,
        functionTrace,
        architectureSkeleton
    } = useGraphStore();

    // Local loading state for initial load or refresh
    const [isRefreshing, setIsRefreshing] = useState(false);

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
                        setIsRefreshing(false);
                    }
                    break;

                case 'architecture-skeleton':
                    if (message.data) {
                        setArchitectureSkeleton(message.data);
                    }
                    break;

                case 'function-trace':
                    if (message.data) {
                        setFunctionTrace(message.data);
                        setViewMode('trace');
                    }
                    break;

                case 'filter-by-directory':
                    if (message.path) {
                        filterByDirectory(message.path);
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

        return () => {
            window.removeEventListener('message', handleMessage);
        };
    }, [setGraphData, setArchitectureSkeleton, setFunctionTrace, filterByDirectory, setViewMode]);

    // Load full graph data when switching to complex views if not already loaded
    useEffect(() => {
        if ((viewMode === 'flow') && !originalGraphData && !isRefreshing) {
            setIsRefreshing(true);
            vscode.postMessage({ type: 'request-graph' });
        }
    }, [viewMode, originalGraphData, isRefreshing]);

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
                type: 'node-selected-webview',
                nodeId,
            } as any; // Using 'any' briefly to bypass type check if needed, but optimally update types.ts
            vscode.postMessage({ type: 'node-selected', nodeId });
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
        setIsRefreshing(true);
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

    const showLoading = isLoading || (originalGraphData === null && isRefreshing) || (originalGraphData === null && !displayedGraphData && !(viewMode === 'trace' && functionTrace) && !(viewMode === 'architecture' && architectureSkeleton));

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
                    {displayedGraphData && (
                        <div className="text-xs opacity-70">
                            {displayedGraphData.domains?.length || 0} domains · {displayedGraphData.symbols.length} symbols ·{' '}
                            {displayedGraphData.edges.length} edges
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
                        disabled={isRefreshing}
                    >
                        {isRefreshing ? 'Loading...' : 'Refresh'}
                    </button>

                    {/* Export Button */}
                    <button
                        onClick={() => handleExport('png')}
                        className="px-3 py-1 text-xs rounded hover:bg-opacity-80"
                        style={{
                            backgroundColor: 'var(--vscode-button-secondaryBackground)',
                            color: 'var(--vscode-button-secondaryForeground)',
                        }}
                        disabled={!displayedGraphData}
                    >
                        Export PNG
                    </button>
                </div>
            </div>

            {/* Main Content Area */}
            <div className="flex-1 flex overflow-hidden">
                {/* Graph Canvas */}
                <div className="flex-1 overflow-hidden">
                    {showLoading ? (
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
                                graphData={displayedGraphData}
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
