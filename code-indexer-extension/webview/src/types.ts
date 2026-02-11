// Types for graph data from extension
export interface GraphSymbol {
    id: number;
    name: string;
    type: 'function' | 'method' | 'class' | 'interface' | 'enum' | 'variable' | 'type';
    filePath: string;
    range: {
        startLine: number;
        startColumn: number;
        endLine: number;
        endColumn: number;
    };
    complexity: number;
    domain?: string | null;
    // AI Metadata
    purpose?: string;
    impactDepth?: number;
    searchTags?: string[];
    fragility?: string;
}

export interface GraphEdge {
    id: number;
    source: string; // Format: "filePath:symbolName:line"
    target: string;
    type: 'call' | 'import' | 'extends' | 'implements';
    reason?: string;
}

export interface GraphFile {
    filePath: string;
    contentHash: string;
    lastIndexedAt: string;
}



// VS Code API for webview
export interface VSCodeAPI {
    postMessage(message: any): void;
    getState(): any;
    setState(state: any): void;
}

declare global {
    interface Window {
        acquireVsCodeApi(): VSCodeAPI;
    }
}

// Message types between extension and webview
export type ExtensionMessage =
    | { type: 'graph-data'; data: GraphData }
    | { type: 'theme-changed'; theme: 'light' | 'dark' };

export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'request-graph' }
    | { type: 'node-selected'; nodeId: string }
    | { type: 'export-image'; format: 'png' | 'svg' };

// Coupling metrics
export interface CouplingMetrics {
    nodeId: string;
    inDegree: number;
    outDegree: number;
    cbo: number; // Coupling Between Objects
    normalizedScore: number; // 0-1 range for color mapping
    color: string; // Hex color from gradient
}

// React Flow node data
export interface FileNodeData extends Record<string, unknown> {
    label?: string;
    filePath: string;
    symbolCount: number;
    avgCoupling: number;
    collapsed: boolean;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
}

export interface SymbolNodeData extends Record<string, unknown> {
    label: string;
    symbolType: GraphSymbol['type'];
    complexity: number;
    coupling: CouplingMetrics;
    filePath: string;
    line: number;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
    isHighlighted?: boolean;
}

// Domain health metrics
export interface DomainHealth {
    domain: string;
    symbolCount: number;
    avgComplexity: number;
    coupling: number;
    healthScore: number;
    status: 'healthy' | 'warning' | 'critical';
}

// Domain node data
export interface DomainNodeData extends Record<string, unknown> {
    domain: string;
    health: DomainHealth;
    collapsed: boolean;
}

// Updated graph data with domains
export interface GraphData {
    symbols: GraphSymbol[];
    edges: GraphEdge[];
    files: GraphFile[];
    domains: { domain: string; symbolCount: number; health: DomainHealth }[];
}
