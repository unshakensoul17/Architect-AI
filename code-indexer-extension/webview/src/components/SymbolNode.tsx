import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { CouplingMetrics } from '../types';

export interface SymbolNodeData extends Record<string, unknown> {
    label: string;
    symbolType: 'function' | 'method' | 'class' | 'interface' | 'enum' | 'variable' | 'type';
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

const SymbolNode = memo(({ data }: NodeProps<Node<SymbolNodeData>>) => {
    const {
        label,
        symbolType,
        complexity,
        coupling,
        isDimmed = false,
        isActive = false,
        isClickable = true,
        isHighlighted = false,
    } = data;

    // Icon based on symbol type
    const getIcon = () => {
        switch (symbolType) {
            case 'function':
                return '𝑓';
            case 'method':
                return 'ⓜ';
            case 'class':
                return 'ⓒ';
            case 'interface':
                return 'ⓘ';
            case 'enum':
                return 'ⓔ';
            case 'variable':
                return 'ⓥ';
            case 'type':
                return 'ⓣ';
            default:
                return '●';
        }
    };

    // Calculate opacity and styling based on visibility state
    const containerOpacity = isDimmed ? 0.2 : 1;
    const borderWidth = isActive || isHighlighted ? 3 : 2;
    const boxShadow = isHighlighted
        ? `0 0 12px ${coupling.color}60, 0 2px 6px rgba(0, 0, 0, 0.2)`
        : '0 2px 6px rgba(0, 0, 0, 0.15)';

    return (
        <div
            className="px-3 py-2 rounded-lg shadow-md min-w-[140px] max-w-[200px]"
            style={{
                backgroundColor: coupling.color + '20',
                borderColor: coupling.color,
                borderWidth: `${borderWidth}px`,
                borderStyle: 'solid',
                color: 'var(--vscode-editor-foreground)',
                opacity: containerOpacity,

                boxShadow,
                cursor: isClickable ? 'pointer' : 'default',
                pointerEvents: isDimmed ? 'none' : 'auto',
            }}
        >
            <Handle type="target" position={Position.Top} className="w-2 h-2" />

            <div className="flex items-center gap-2">
                <span
                    className="text-lg font-bold"
                    style={{ color: coupling.color }}
                    title={`Type: ${symbolType}`}
                >
                    {getIcon()}
                </span>
                <div className="flex-1 min-w-0">
                    <div className="text-xs font-semibold truncate" title={label}>
                        {label}
                    </div>
                    <div className="text-[10px] opacity-70 flex items-center gap-2">
                        <span title={`Complexity: ${complexity}`}>C:{complexity}</span>
                        <span title={`Coupling: ${coupling.cbo}`}>CBO:{coupling.cbo}</span>
                    </div>
                </div>
                {isHighlighted && (
                    <div
                        className="text-[9px] px-1 py-0.5 rounded"
                        style={{
                            backgroundColor: coupling.color + '40',
                            color: coupling.color,
                        }}
                    >
                        ★
                    </div>
                )}
            </div>

            <Handle type="source" position={Position.Bottom} className="w-2 h-2" />
        </div>
    );
});

SymbolNode.displayName = 'SymbolNode';

export default SymbolNode;
