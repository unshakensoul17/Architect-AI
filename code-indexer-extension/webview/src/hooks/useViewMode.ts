import { useState, useCallback, useEffect } from 'react';
import type { ViewMode, ViewState, ImpactStats } from '../types/viewMode';
import type { VSCodeAPI } from '../types';

/**
 * Global View Mode Hook
 * Manages view mode state with VS Code persistence
 */

interface UseViewModeReturn {
    currentMode: ViewMode;
    switchMode: (mode: ViewMode) => void;
    focusedNodeId: string | null;
    setFocusedNodeId: (nodeId: string | null) => void;
    relatedNodeIds: Set<string>;
    setRelatedNodeIds: (ids: Set<string>) => void;
    impactStats: ImpactStats | null;
    setImpactStats: (stats: ImpactStats | null) => void;
    viewState: ViewState;
}

export function useViewMode(vscode: VSCodeAPI): UseViewModeReturn {
    const [currentMode, setCurrentMode] = useState<ViewMode>('architecture');
    const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
    const [relatedNodeIds, setRelatedNodeIds] = useState<Set<string>>(new Set());
    const [impactStats, setImpactStats] = useState<ImpactStats | null>(null);

    // Load persisted state on mount
    useEffect(() => {
        const savedState = vscode.getState();
        if (savedState?.viewMode) {
            setCurrentMode(savedState.viewMode);
        }
    }, [vscode]);

    // Switch view mode and persist
    const switchMode = useCallback(
        (mode: ViewMode) => {
            setCurrentMode(mode);
            vscode.setState({ viewMode: mode });

            // Reset focused node when switching modes (except for impact mode)
            if (mode !== 'impact') {
                setFocusedNodeId(null);
                setRelatedNodeIds(new Set());
                setImpactStats(null);
            }
        },
        [vscode]
    );

    const viewState: ViewState = {
        currentMode,
        focusedNodeId,
        relatedNodeIds,
        impactStats,
    };

    return {
        currentMode,
        switchMode,
        focusedNodeId,
        setFocusedNodeId,
        relatedNodeIds,
        setRelatedNodeIds,
        impactStats,
        setImpactStats,
        viewState,
    };
}
