import { memo, useState } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import type { FileNodeData } from '../types';

const FileNode = memo(({ data }: NodeProps<Node<FileNodeData>>) => {
    const { filePath, symbolCount, avgCoupling, collapsed } = data;
    const [isCollapsed, setIsCollapsed] = useState(collapsed);

    const fileName = filePath.split('/').pop() || filePath;
    const dirPath = filePath.substring(0, filePath.lastIndexOf('/'));

    // Color based on average coupling
    const getBorderColor = () => {
        if (avgCoupling < 0.3) return '#3b82f6'; // Blue
        if (avgCoupling < 0.6) return '#fbbf24'; // Yellow
        return '#ef4444'; // Red
    };

    return (
        <div
            className="rounded-lg border-2 shadow-lg bg-opacity-90"
            style={{
                backgroundColor: 'var(--vscode-sideBar-background, #252526)',
                borderColor: getBorderColor(),
                minWidth: isCollapsed ? '200px' : '300px',
                minHeight: isCollapsed ? '80px' : '150px',
            }}
        >
            <Handle type="target" position={Position.Top} className="w-3 h-3" />

            {/* Header */}
            <div
                className="px-3 py-2 border-b cursor-pointer hover:bg-opacity-80"
                style={{
                    backgroundColor: getBorderColor() + '30',
                    borderColor: getBorderColor(),
                }}
                onClick={() => setIsCollapsed(!isCollapsed)}
            >
                <div className="flex items-center justify-between">
                    <div className="flex-1 min-w-0">
                        <div className="text-sm font-bold truncate" title={fileName}>
                            📄 {fileName}
                        </div>
                        <div className="text-[10px] opacity-70 truncate" title={dirPath}>
                            {dirPath}
                        </div>
                    </div>
                    <button className="ml-2 text-xs px-2 py-1 rounded hover:bg-black hover:bg-opacity-20">
                        {isCollapsed ? '▶' : '▼'}
                    </button>
                </div>
            </div>

            {/* Stats */}
            {!isCollapsed && (
                <div className="px-3 py-2 text-xs">
                    <div className="flex items-center justify-between mb-1">
                        <span className="opacity-70">Symbols:</span>
                        <span className="font-semibold">{symbolCount}</span>
                    </div>
                    <div className="flex items-center justify-between">
                        <span className="opacity-70">Avg Coupling:</span>
                        <span
                            className="font-semibold px-2 py-0.5 rounded"
                            style={{
                                backgroundColor: getBorderColor() + '40',
                                color: getBorderColor(),
                            }}
                        >
                            {(avgCoupling * 100).toFixed(0)}%
                        </span>
                    </div>
                </div>
            )}

            <Handle type="source" position={Position.Bottom} className="w-3 h-3" />
        </div>
    );
});

FileNode.displayName = 'FileNode';

export default FileNode;
