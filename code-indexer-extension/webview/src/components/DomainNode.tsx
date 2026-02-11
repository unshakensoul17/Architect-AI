import { memo } from 'react';
import { Handle, Position } from '@xyflow/react';

export interface DomainNodeData extends Record<string, unknown> {
    domain: string;
    health: {
        domain: string;
        symbolCount: number;
        avgComplexity: number;
        coupling: number;
        healthScore: number;
        status: 'healthy' | 'warning' | 'critical';
    };
    collapsed: boolean;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
}

interface DomainNodeProps {
    data: DomainNodeData;
}

const DomainNode = memo(({ data }: DomainNodeProps) => {
    const {
        domain,
        health,
        collapsed,
        isDimmed = false,
        isActive = false,
        isClickable = true
    } = data;
    const { healthScore, status, symbolCount, avgComplexity, coupling } = health;

    // Get domain display name and icon
    const domainDisplayNames: Record<string, string> = {
        auth: '🔐 Authentication',
        payment: '💳 Payment',
        api: '🔌 API',
        database: '🗄️ Database',
        notification: '🔔 Notification',
        core: '⚙️ Core',
        ui: '🎨 UI',
        util: '🔧 Utilities',
        test: '🧪 Tests',
        config: '⚙️ Configuration',
        unknown: '❓ Unknown',
    };

    const displayName = domainDisplayNames[domain] || `📦 ${domain}`;

    // Health color
    const healthColors = {
        healthy: {
            border: '#10b981',
            bg: '#10b98120',
            text: '#10b981',
        },
        warning: {
            border: '#fbbf24',
            bg: '#fbbf2420',
            text: '#fbbf24',
        },
        critical: {
            border: '#ef4444',
            bg: '#ef444420',
            text: '#ef4444',
        },
    };

    const colors = healthColors[status];

    // Health emoji
    const healthEmoji = status === 'healthy' ? '✅' : status === 'warning' ? '⚠️' : '❌';

    // Calculate opacity and styling based on visibility state
    const containerOpacity = isDimmed ? 0.3 : 1;
    const borderWidth = isActive ? 4 : 3;
    const boxShadow = isActive
        ? `0 0 20px ${colors.border}40, 0 4px 12px rgba(0, 0, 0, 0.15)`
        : '0 4px 12px rgba(0, 0, 0, 0.15)';

    return (
        <div
            style={{
                minWidth: '400px',
                minHeight: collapsed ? '120px' : '200px',
                border: `${borderWidth}px solid ${colors.border}`,
                borderRadius: '12px',
                backgroundColor: 'var(--vscode-editor-background)',
                padding: 0,
                boxShadow,
                opacity: containerOpacity,
                transition: 'opacity 0.3s ease, box-shadow 0.3s ease, border-width 0.2s ease',
                cursor: isClickable ? 'pointer' : 'default',
                pointerEvents: isDimmed ? 'none' : 'auto',
            }}
            className={isClickable ? 'hover:ring-2 hover:ring-blue-400' : ''}
        >
            <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />

            {/* Header */}
            <div
                style={{
                    padding: '16px',
                    borderBottom: `2px solid ${colors.border}`,
                    background: colors.bg,
                    borderTopLeftRadius: '9px',
                    borderTopRightRadius: '9px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                }}
            >
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
                        {displayName}
                    </div>
                    <div
                        style={{
                            fontSize: '11px',
                            padding: '4px 8px',
                            borderRadius: '12px',
                            backgroundColor: 'var(--vscode-badge-background)',
                            color: 'var(--vscode-badge-foreground)',
                        }}
                    >
                        {symbolCount} symbols
                    </div>
                    {isClickable && (
                        <div
                            style={{
                                fontSize: '10px',
                                padding: '2px 6px',
                                borderRadius: '4px',
                                backgroundColor: '#3b82f620',
                                color: '#3b82f6',
                            }}
                        >
                            Click to explore →
                        </div>
                    )}
                </div>

                {/* Health Badge */}
                <div
                    style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '8px',
                        fontSize: '14px',
                        fontWeight: 'bold',
                        color: colors.text,
                    }}
                >
                    <span>{healthEmoji}</span>
                    <span>{healthScore}% Healthy</span>
                </div>
            </div>

            {/* Body */}
            {!collapsed && (
                <div style={{ padding: '16px' }}>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
                        {/* Complexity */}
                        <div>
                            <div
                                style={{
                                    fontSize: '11px',
                                    opacity: 0.7,
                                    marginBottom: '4px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                }}
                            >
                                Avg Complexity
                            </div>
                            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
                                {avgComplexity.toFixed(1)}
                            </div>
                        </div>

                        {/* Coupling */}
                        <div>
                            <div
                                style={{
                                    fontSize: '11px',
                                    opacity: 0.7,
                                    marginBottom: '4px',
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.5px',
                                }}
                            >
                                Coupling Ratio
                            </div>
                            <div style={{ fontSize: '20px', fontWeight: 'bold' }}>
                                {(coupling * 100).toFixed(0)}%
                            </div>
                        </div>
                    </div>

                    {/* Health Bar */}
                    <div style={{ marginTop: '16px' }}>
                        <div
                            style={{
                                height: '8px',
                                backgroundColor: 'var(--vscode-input-background)',
                                borderRadius: '4px',
                                overflow: 'hidden',
                            }}
                        >
                            <div
                                style={{
                                    width: `${healthScore}%`,
                                    height: '100%',
                                    backgroundColor: colors.border,
                                    transition: 'width 0.3s ease',
                                }}
                            />
                        </div>
                    </div>
                </div>
            )}

            <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
        </div>
    );
});

DomainNode.displayName = 'DomainNode';

export default DomainNode;
