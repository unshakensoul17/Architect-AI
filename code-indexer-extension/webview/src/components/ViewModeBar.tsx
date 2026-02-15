import { memo } from 'react';
import type { ViewMode } from '../types/viewMode';

interface ViewModeBarProps {
    currentMode: ViewMode;
    onModeChange: (mode: ViewMode) => void;
    maxDepth: number;
    onDepthChange: (depth: number) => void;
}

const ViewModeBar = memo(({ currentMode, onModeChange, maxDepth, onDepthChange }: ViewModeBarProps) => {
    const modes: Array<{ id: ViewMode; label: string; icon: string; description: string }> = [
        {
            id: 'architecture',
            label: 'Architecture',
            icon: '🏗️',
            description: 'Learn system structure',
        },
        {
            id: 'trace',
            label: 'Trace',
            icon: '🔍',
            description: 'Micro-view of function calls',
        },
        {
            id: 'flow',
            label: 'Flow',
            icon: '🔄',
            description: 'Trace execution paths',
        },
    ];

    return (
        <div
            className="view-mode-bar"
            style={{
                display: 'flex',
                gap: '8px',
                padding: '12px 16px',
                backgroundColor: 'var(--vscode-sideBar-background)',
                borderBottom: '1px solid var(--vscode-panel-border)',
            }}
        >
            {modes.map((mode) => (
                <button
                    key={mode.id}
                    onClick={() => onModeChange(mode.id)}
                    className="mode-button"
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px',
                        padding: '8px 14px',
                        borderRadius: '6px',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: currentMode === mode.id ? '600' : '400',
                        backgroundColor:
                            currentMode === mode.id
                                ? 'var(--vscode-button-background)'
                                : 'var(--vscode-button-secondaryBackground)',
                        color:
                            currentMode === mode.id
                                ? 'var(--vscode-button-foreground)'
                                : 'var(--vscode-button-secondaryForeground)',
                        transition: 'all 0.2s ease',
                        boxShadow:
                            currentMode === mode.id
                                ? '0 2px 8px rgba(0, 0, 0, 0.2)'
                                : 'none',
                    }}
                    title={mode.description}
                >
                    <span style={{ fontSize: '16px' }}>{mode.icon}</span>
                    <span>{mode.label}</span>
                </button>
            ))}
            {currentMode === 'flow' && (
                <div
                    style={{
                        marginLeft: 'auto',
                        display: 'flex',
                        alignItems: 'center',
                        gap: '12px',
                        padding: '4px 8px',
                        backgroundColor: 'var(--vscode-editor-background)',
                        borderRadius: '6px',
                        border: '1px solid var(--vscode-panel-border)',
                    }}
                >
                    <span style={{ fontSize: '12px', opacity: 0.8, fontWeight: '500' }}>Detail Level:</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                        <button
                            onClick={() => onDepthChange(Math.max(0, maxDepth - 1))}
                            disabled={maxDepth <= 0}
                            style={{
                                width: '24px',
                                height: '24px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                border: 'none',
                                borderRadius: '4px',
                                backgroundColor: 'var(--vscode-button-secondaryBackground)',
                                color: 'var(--vscode-button-secondaryForeground)',
                                cursor: maxDepth <= 0 ? 'not-allowed' : 'pointer',
                                opacity: maxDepth <= 0 ? 0.5 : 1,
                            }}
                        >
                            -
                        </button>
                        <span style={{ minWidth: '80px', textAlign: 'center', fontSize: '13px', fontWeight: '600' }}>
                            {maxDepth === 0 ? 'Domains' : maxDepth === 1 ? 'Files' : 'Symbols'}
                        </span>
                        <button
                            onClick={() => onDepthChange(Math.min(2, maxDepth + 1))}
                            disabled={maxDepth >= 2}
                            style={{
                                width: '24px',
                                height: '24px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                border: 'none',
                                borderRadius: '4px',
                                backgroundColor: 'var(--vscode-button-secondaryBackground)',
                                color: 'var(--vscode-button-secondaryForeground)',
                                cursor: maxDepth >= 2 ? 'not-allowed' : 'pointer',
                                opacity: maxDepth >= 2 ? 0.5 : 1,
                            }}
                        >
                            +
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
});

ViewModeBar.displayName = 'ViewModeBar';

export default ViewModeBar;
