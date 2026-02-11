/**
 * View Mode System Types
 * Supports 4 analysis modes: Architecture, Flow, Risk, and Impact
 */

export type ViewMode = 'architecture' | 'flow' | 'risk' | 'impact';

export interface ViewState {
    currentMode: ViewMode;
    focusedNodeId: string | null;
    relatedNodeIds: Set<string>;
    impactStats: ImpactStats | null;
}

export interface ImpactStats {
    affectedFunctions: number;
    affectedFiles: number;
    affectedDomains: number;
    upstreamDeps: string[];
    downstreamDeps: string[];
}

export interface FocusConfig {
    centerDuration: number;      // Animation duration in ms
    zoomLevel: number;            // Target zoom level
    fadeOpacity: number;          // Opacity for unrelated nodes
    highlightOpacity: number;     // Opacity for related nodes
    debounceMs: number;           // Debounce delay
}

export const DEFAULT_FOCUS_CONFIG: FocusConfig = {
    centerDuration: 800,
    zoomLevel: 1.2,
    fadeOpacity: 0.15,
    highlightOpacity: 1.0,
    debounceMs: 100,
};

// Node visibility states for rendering
export interface NodeVisibilityState {
    isVisible: boolean;
    opacity: number;
    isHighlighted: boolean;
    glowColor?: string;  // For risk mode
}

// Edge visibility and styling
export interface EdgeVisibilityState {
    isVisible: boolean;
    opacity: number;
    strokeWidth: number;
    importance: 'high' | 'medium' | 'low';
    label?: string;  // For impact mode
}

// Risk thresholds for Risk Mode
export interface RiskThresholds {
    complexity: number;    // e.g., 10
    coupling: number;      // e.g., 0.6 (60%)
    health: number;        // e.g., 60 (60%)
}

export const DEFAULT_RISK_THRESHOLDS: RiskThresholds = {
    complexity: 10,
    coupling: 0.6,
    health: 60,
};

// Execution flow for Flow Mode
export interface ExecutionFlow {
    entryPoint: string;    // Node ID
    sinks: string[];       // Node IDs of endpoints
    path: string[];        // All node IDs on the path
    type: 'api' | 'main' | 'route' | 'event';
}

// Related nodes from relationship detection
export interface RelatedNodes {
    parents: Set<string>;    // Direct parent nodes
    children: Set<string>;   // Direct child nodes
    callers: Set<string>;    // Nodes with incoming edges
    callees: Set<string>;    // Nodes with outgoing edges
    sameFile: Set<string>;   // Symbols in the same file
    all: Set<string>;        // Union of all above
}

// Impact analysis result
export interface ImpactAnalysis {
    nodeId: string;
    upstream: string[];      // Who depends on this (callers)
    downstream: string[];    // What this depends on (callees)
    affectedFiles: Set<string>;
    affectedDomains: Set<string>;
    stats: ImpactStats;
}

// Filter context for graph filtering
export interface FilterContext {
    mode: ViewMode;
    focusedNodeId: string | null;
    relatedNodeIds: Set<string>;
    riskThresholds: RiskThresholds;
    executionFlows?: ExecutionFlow[];
}

// Layout configuration per mode
export interface LayoutModeConfig {
    direction: 'DOWN' | 'RIGHT' | 'UP' | 'LEFT';
    nodeSpacing: number;
    layerSpacing: number;
}

export const MODE_LAYOUT_CONFIGS: Record<ViewMode, LayoutModeConfig> = {
    architecture: {
        direction: 'DOWN',
        nodeSpacing: 60,
        layerSpacing: 100,
    },
    flow: {
        direction: 'RIGHT',
        nodeSpacing: 80,
        layerSpacing: 120,
    },
    risk: {
        direction: 'DOWN',
        nodeSpacing: 50,
        layerSpacing: 80,
    },
    impact: {
        direction: 'DOWN',
        nodeSpacing: 60,
        layerSpacing: 100,
    },
};
