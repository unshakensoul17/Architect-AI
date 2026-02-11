/**
 * Inspector Panel - Main Container Component
 *
 * CRITICAL PERFORMANCE:
 * - Uses stable selectors to prevent re-render cascades
 * - Debounces data fetching on selection change
 * - useRef for timers (not state)
 * - All child components are memoized
 */

import { memo, useEffect, useCallback, useRef } from 'react';
import {
    useSelectedId,
    useNodeType,
    useInspectorActions,
} from '../../stores/useInspectorStore';
import { getDataProvider } from '../../panel/dataProvider';
import SelectionHeader from './SelectionHeader';
import OverviewSection from './OverviewSection';
import DependenciesSection from './DependenciesSection';
import RisksHealthSection from './RisksHealthSection';
import AIActionsSection from './AIActionsSection';
import RefactorImpactSection from './RefactorImpactSection';
import type { VSCodeAPI } from '../../types';
import './InspectorPanel.css';

interface InspectorPanelProps {
    vscode: VSCodeAPI;
    onClose: () => void;
    onFocusNode: (nodeId: string) => void;
}

const InspectorPanel = memo(({ vscode, onClose, onFocusNode }: InspectorPanelProps) => {
    // Use individual stable selectors
    const selectedId = useSelectedId();
    const nodeType = useNodeType();
    const {
        setOverview,
        setDeps,
        setRisks,
        setLoadingOverview,
        setLoadingDeps,
        setLoadingRisks,
    } = useInspectorActions();

    // Ref for debounce timer - NOT state to avoid re-renders
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const fetchedIdRef = useRef<string | null>(null);

    // Fetch data when selection changes (debounced 50ms)
    useEffect(() => {
        // Clear previous timer
        if (debounceRef.current) {
            clearTimeout(debounceRef.current);
            debounceRef.current = null;
        }

        // Skip if no selection or same as already fetched
        if (!selectedId || !nodeType) {
            return;
        }

        // Prevent duplicate fetches for same ID
        if (fetchedIdRef.current === selectedId) {
            return;
        }

        debounceRef.current = setTimeout(async () => {
            fetchedIdRef.current = selectedId;
            const provider = getDataProvider(vscode);

            // Set loading states BEFORE fetch
            setLoadingOverview(true);
            setLoadingDeps(true);
            setLoadingRisks(true);

            // Fetch all sections in parallel
            try {
                const [overview, deps, risks] = await Promise.allSettled([
                    provider.getOverview(selectedId, nodeType),
                    provider.getDependencies(selectedId, nodeType),
                    provider.getRisks(selectedId, nodeType),
                ]);

                // Handle results - only update if still same selection
                if (fetchedIdRef.current === selectedId) {
                    if (overview.status === 'fulfilled') {
                        setOverview(overview.value);
                    } else {
                        setLoadingOverview(false);
                        console.warn('Failed to fetch overview:', overview.reason);
                    }

                    if (deps.status === 'fulfilled') {
                        setDeps(deps.value);
                    } else {
                        setLoadingDeps(false);
                        console.warn('Failed to fetch deps:', deps.reason);
                    }

                    if (risks.status === 'fulfilled') {
                        setRisks(risks.value);
                    } else {
                        setLoadingRisks(false);
                        console.warn('Failed to fetch risks:', risks.reason);
                    }
                }
            } catch (error) {
                console.error('Failed to fetch inspector data:', error);
                setLoadingOverview(false);
                setLoadingDeps(false);
                setLoadingRisks(false);
            }
        }, 50); // 50ms debounce

        return () => {
            if (debounceRef.current) {
                clearTimeout(debounceRef.current);
                debounceRef.current = null;
            }
        };
    }, [selectedId, nodeType, vscode, setOverview, setDeps, setRisks, setLoadingOverview, setLoadingDeps, setLoadingRisks]);

    // Handle dependency click - focus node in graph
    const handleDependencyClick = useCallback(
        (depId: string) => {
            onFocusNode(depId);
        },
        [onFocusNode]
    );

    // Empty state when no selection
    if (!selectedId) {
        return (
            <div className="inspector-panel inspector-empty">
                <div className="inspector-header">
                    <h2>Inspector</h2>
                    <button
                        className="inspector-close-btn"
                        onClick={onClose}
                        title="Close Inspector"
                    >
                        ×
                    </button>
                </div>
                <div className="inspector-empty-state">
                    <span className="inspector-empty-icon">📋</span>
                    <p>Select a node in the graph to inspect</p>
                </div>
            </div>
        );
    }

    return (
        <div className="inspector-panel">
            {/* Header */}
            <div className="inspector-header">
                <h2>Inspector</h2>
                <button
                    className="inspector-close-btn"
                    onClick={onClose}
                    title="Close Inspector"
                >
                    ×
                </button>
            </div>

            {/* Scrollable Content */}
            <div className="inspector-content">
                <SelectionHeader />
                <OverviewSection />
                <DependenciesSection onDependencyClick={handleDependencyClick} />
                <RisksHealthSection vscode={vscode} />
                <AIActionsSection vscode={vscode} />
                <RefactorImpactSection vscode={vscode} />
            </div>
        </div>
    );
});

InspectorPanel.displayName = 'InspectorPanel';

export default InspectorPanel;
