import { memo } from 'react';
import type { ViewMode } from '../types/viewMode';

interface ViewModeBarProps {
    currentMode: ViewMode;
    onModeChange: (mode: ViewMode) => void;
}

const ViewModeBar = memo(({ currentMode, onModeChange }: ViewModeBarProps) => {
    const modes: Array<{ id: ViewMode; label: string; icon: string; description: string }> = [
        {
            id: 'architecture',
            label: 'Architecture',
            icon: '🏗️',
            description: 'Learn system structure',
        },
        {
            id: 'flow',
            label: 'Flow',
            icon: '🔄',
            description: 'Trace execution paths',
        },
        {
            id: 'risk',
            label: 'Risk',
            icon: '⚠️',
            description: 'Find fragile code',
        },
        {
            id: 'impact',
            label: 'Change Impact',
            icon: '💥',
            description: 'Analyze blast radius',
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
        </div>
    );
});

ViewModeBar.displayName = 'ViewModeBar';

export default ViewModeBar;
