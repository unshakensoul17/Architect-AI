import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { SymbolNodeData } from '../types';

const SymbolNode = memo(({ data }: NodeProps<Node<SymbolNodeData>>) => {
    const { label, symbolType, complexity, coupling } = data;

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

    return (
        <div
            className="px-3 py-2 rounded-lg border-2 shadow-md min-w-[140px] max-w-[200px]"
            style={{
                backgroundColor: coupling.color + '20', // 20% opacity
                borderColor: coupling.color,
                color: 'var(--vscode-editor-foreground)',
            }}
        >
            <Handle type="target" position={Position.Top} className="w-2 h-2" />

            <div className="flex items-center gap-2">
                <span className="text-lg font-bold" style={{ color: coupling.color }}>
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
            </div>

            <Handle type="source" position={Position.Bottom} className="w-2 h-2" />
        </div>
    );
});

SymbolNode.displayName = 'SymbolNode';

export default SymbolNode;
