import { memo } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';

export interface FileNodeData extends Record<string, unknown> {
    label?: string;
    filePath: string;
    symbolCount: number;
    avgCoupling: number;
    avgFragility?: number;
    totalBlastRadius?: number;
    collapsed: boolean;
    // Progressive visibility states
    isDimmed?: boolean;
    isActive?: boolean;
    isClickable?: boolean;
}

const FileNode = memo(({ data, style }: NodeProps<Node<FileNodeData>> & { style?: React.CSSProperties }) => {
    const {
        filePath,
        symbolCount,
        avgCoupling,
        isDimmed = false,
        isActive = false,
        isClickable = true,
    } = data;

    const fileName = filePath.split('/').pop() || filePath;
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

    // Color based on average coupling
    const getBorderColor = () => {
        if (avgCoupling < 0.3) return '#3b82f6'; // Blue
        if (avgCoupling < 0.6) return '#fbbf24'; // Yellow
        return '#ef4444'; // Red
    };

    const borderColor = getBorderColor();

    // Calculate opacity and styling based on visibility state
    const containerOpacity = isDimmed ? 0.25 : 1;
    const borderWidth = isActive ? 3 : 2;
    const boxShadow = isActive
        ? `0 0 15px ${borderColor}40, 0 4px 8px rgba(0, 0, 0, 0.2)`
        : '0 2px 8px rgba(0, 0, 0, 0.15)';

    return (
        <div
            className="rounded-lg shadow-lg bg-opacity-90"
            style={{
                ...style,
                backgroundColor: 'var(--vscode-sideBar-background, #252526)',
                borderColor,
                borderWidth: `${borderWidth}px`,
                borderStyle: 'solid',

                opacity: containerOpacity,
                boxShadow,
                cursor: isClickable ? 'pointer' : 'default',
                pointerEvents: isDimmed ? 'none' : 'auto',
            }}
        >
            <Handle type="target" position={Position.Top} className="w-3 h-3" />

            {/* Header */}
            <div
                className="px-3 py-2 border-b"
                style={{
                    backgroundColor: borderColor + '30',
                    borderColor,
                }}
            >
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                        {/* Collapse Toggle */}
                        <div
                            onClick={(e) => {
                                e.stopPropagation();
                                if (typeof data.onToggleCollapse === 'function') {
                                    data.onToggleCollapse();
                                }
                            }}
                            className="cursor-pointer hover:bg-black/10 rounded px-1"
                        >
                            {data.collapsed ? '▶' : '▼'}
                        </div>

                        <div className="min-w-0">
                            <div className="text-sm font-bold truncate flex items-center gap-2" title={fileName}>
                                📄 {fileName}
                            </div>
                            <div className="text-[10px] opacity-70 truncate" title={dirPath}>
                                {dirPath}
                            </div>
                        </div>
                    </div>
                    {isActive && (
                        <div
                            className="text-xs px-2 py-1 rounded"
                            style={{
                                backgroundColor: borderColor + '40',
                                color: borderColor,
                            }}
                        >
                            Active
                        </div>
                    )}
                </div>
            </div>

            {/* Stats - Only show if not collapsed */}
            {!data.collapsed && (
                <div className="px-3 py-2 text-xs">
                    <div className="flex items-center justify-between mb-1">
                        <span className="opacity-70">Symbols:</span>
                        <span className="font-semibold">{symbolCount}</span>
                    </div>
                    {data.avgFragility !== undefined && (
                        <div className="flex items-center justify-between mb-1" title="Complexity * Fan-out">
                            <span className="opacity-70">Avg Fragility:</span>
                            <span className="font-semibold" style={{ color: data.avgFragility > 50 ? '#ef4444' : '#fbbf24' }}>
                                {data.avgFragility.toFixed(1)}
                            </span>
                        </div>
                    )}
                    {data.totalBlastRadius !== undefined && (
                        <div className="flex items-center justify-between mb-1" title="Recursive impact (symbols depending on this file)">
                            <span className="opacity-70">Blast Radius:</span>
                            <span className="font-semibold text-red-500">
                                {data.totalBlastRadius}
                            </span>
                        </div>
                    )}
                    {avgCoupling > 0 && (
                        <div className="flex items-center justify-between">
                            <span className="opacity-70">Avg Coupling:</span>
                            <span
                                className="font-semibold px-2 py-0.5 rounded"
                                style={{
                                    backgroundColor: borderColor + '40',
                                    color: borderColor,
                                }}
                            >
                                {(avgCoupling * 100).toFixed(0)}%
                            </span>
                        </div>
                    )}
                </div>
            )}

            <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
        </div>
    );
});

FileNode.displayName = 'FileNode';

export default FileNode;
