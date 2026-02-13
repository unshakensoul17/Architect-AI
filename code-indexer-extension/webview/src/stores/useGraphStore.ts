import { create } from 'zustand';
import { GraphData, GraphSymbol, GraphEdge } from '../types';

interface GraphState {
    originalGraphData: GraphData | null;
    displayedGraphData: GraphData | null;
    filterPath: string | null;
    isLoading: boolean;

    // Actions
    setGraphData: (data: GraphData) => void;
    filterByDirectory: (path: string) => void;
    clearFilter: () => void;
    setLoading: (loading: boolean) => void;
}

export const useGraphStore = create<GraphState>((set, get) => ({
    originalGraphData: null,
    displayedGraphData: null,
    filterPath: null,
    isLoading: false,

    setGraphData: (data) => {
        set({
            originalGraphData: data,
            displayedGraphData: data,
            filterPath: null,
            isLoading: false
        });
    },

    filterByDirectory: (targetPath: string) => {
        const { originalGraphData } = get();

        if (!originalGraphData) return;

        // Normalized target path for comparison
        const normalizedTarget = targetPath.replace(/\\/g, '/');

        // 1. Filter Symbols (Nodes)
        const filteredSymbols = originalGraphData.symbols.filter(symbol => {
            const symbolPath = symbol.filePath.replace(/\\/g, '/');
            return symbolPath.startsWith(normalizedTarget);
        });

        // Create a Set of allowed file paths for faster edge filtering
        // We also need to include the "domain" nodes if they are relevant, 
        // but for now let's focus on file/symbol nodes.
        // Actually, if we filter by directory, we probably only want symbols *inside* that directory.

        const allowedSymbolIds = new Set(filteredSymbols.map(s => s.id));

        // We also need to keep track of allowed file nodes if we have them in the graph
        // The current graph structure puts symbols as nodes. 
        // If there are file nodes, they are likely implementation details of the visualization 
        // but the raw data has 'symbols'. 

        // 2. Filter Edges
        const filteredEdges = originalGraphData.edges.filter(edge => {
            // Edges connect symbols. We need to check if source and target are in our allowed list.
            // Edge source/target format in `types.ts` is "filePath:symbolName:line" OR "domain:..."
            // But wait, `GraphEdge` definition says source/target are strings.
            // Let's look at `GraphSymbol` - it has an `id`. 
            // The `GraphEdge` in `types.ts` has `source` and `target` as strings.
            // We need to resolve these strings to the symbols or check the strings directly.

            // Actually, let's look at how nodes are constructed in App.tsx/GraphCanvas. 
            // The extension sends `GraphData`. 
            // In `filterByDirectory`, we perform the filter on the raw data.

            // Heuristic: check if the path is contained in the source/target ID string?
            // "filePath:symbolName:line"
            // If we strictly filter by `filePath.startsWith(targetPath)`, we can just check the IDs.

            const sourceId = edge.source;
            const targetId = edge.target;

            // Helper to check if an ID belongs to the filtered set
            // For now, let's assume we can check if the basic path is in the allowed set.
            // But `dataset` might vary. 
            // Let's rely on the `filteredSymbols` we just found.

            // We need to match the edge source/target string to the symbol.
            // This is O(N*M) if naive. 
            // Better: construct a Set of "valid node IDs" from filteredSymbols.
            // But wait, `GraphSymbol` has numeric `id`, but `GraphEdge` uses string `source`/`target`.
            // We need to know how `source`/`target` strings are constructed.
            // Looking at `types.ts`: `source: string; // Format: "filePath:symbolName:line"`

            // So we can just check if the string starts with the target path? 
            // BEWARE: Windows paths vs POSIX keys. 
            // `normalizedTarget` allows `startsWith`.

            const sourcePath = sourceId.split(':')[0].replace(/\\/g, '/');
            const targetPath = targetId.split(':')[0].replace(/\\/g, '/');

            return sourcePath.startsWith(normalizedTarget) && targetPath.startsWith(normalizedTarget);
        });

        // 3. Filter Domains/Files (if needed) - purely derived from symbols usually
        // But `GraphData` has `domains` array. We should filter those too or re-calculate?
        // For now, let's just keep domains that have at least one visible symbol.
        const activeDomains = new Set(filteredSymbols.map(s => s.domain).filter(Boolean));
        const filteredDomains = originalGraphData.domains.filter(d => activeDomains.has(d.domain));

        // 4. Construct new GraphData
        const newGraphData: GraphData = {
            ...originalGraphData,
            symbols: filteredSymbols,
            edges: filteredEdges,
            domains: filteredDomains,
            // Files list should also be filtered
            files: originalGraphData.files.filter(f => f.filePath.replace(/\\/g, '/').startsWith(normalizedTarget))
        };

        set({
            displayedGraphData: newGraphData,
            filterPath: targetPath
        });
    },

    clearFilter: () => {
        const { originalGraphData } = get();
        if (originalGraphData) {
            set({
                displayedGraphData: originalGraphData,
                filterPath: null
            });
        }
    },

    setLoading: (loading) => set({ isLoading: loading })
}));
