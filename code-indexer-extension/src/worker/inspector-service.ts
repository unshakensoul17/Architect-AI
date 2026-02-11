/**
 * Inspector Service
 * Handles business logic for the inspector panel
 * - Fetches data from database
 * - Calculates metrics
 * - Delegates AI actions to orchestrator
 * 
 * Note: Node IDs use specific formats:
 * - Domain: "domain:Name"
 * - File: "domain:FilePath" (though usually just "FilePath" internally) -> logic needs to handle prefixes
 * - Symbol: "FilePath:Name:Line"
 */

import { CodeIndexDatabase } from '../db/database';
import { AIOrchestrator } from '../ai/orchestrator';
import {
    InspectorOverviewData,
    InspectorDependencyData,
    InspectorRiskData,
    InspectorAIResult,
    InspectorDependencyItem
} from './message-protocol';

export class InspectorService {
    constructor(
        private db: CodeIndexDatabase,
        private orchestrator: AIOrchestrator
    ) { }

    /**
     * Get overview data for a selected node
     */
    async getOverview(nodeId: string, nodeType: 'domain' | 'file' | 'symbol'): Promise<InspectorOverviewData> {
        const data: InspectorOverviewData = {
            nodeType,
            name: '',
            path: '',
        };

        try {
            if (nodeType === 'domain') {
                const domainName = nodeId.replace(/^domain:/, '');
                data.name = domainName;
                data.path = 'Domain';

                const files = this.db.getFilesByDomain(domainName);
                if (files) {
                    data.fileCount = files.length;
                    let functionCount = 0;
                    // Aggregate function count
                    for (const file of files) {
                        const stats = this.db.getFileStats(file.filePath);
                        if (stats) functionCount += stats.functionCount;
                    }
                    data.functionCount = functionCount;
                    // Mock health/coupling for now until metrics engine is ready
                    data.healthPercent = 85;
                    data.coupling = 0.3;
                }
            } else if (nodeType === 'file') {
                // Remove potential domain prefix if present for lookup
                let filePath = nodeId;
                if (filePath.startsWith('domain:')) {
                    filePath = filePath.substring(7);
                }

                data.name = filePath.split('/').pop() || filePath;
                data.path = filePath;

                const file = this.db.getFile(filePath);
                if (file) {
                    data.lastModified = file.lastModified;
                }

                const stats = this.db.getFileStats(filePath);
                if (stats) {
                    data.symbolCount = stats.symbolCount; // Assuming this exists in stats
                    data.importCount = 0; // Need to calculate from edges
                    data.exportCount = 0; // Need to calculate
                    data.avgComplexity = 5; // Placeholder
                }

                // Calculate imports/exports from edges
                const symbols = this.db.getSymbolsByFile(filePath);
                if (symbols && symbols.length > 0) {
                    let totalComplexity = 0;
                    let complexityCount = 0;

                    for (const sym of symbols) {
                        if (sym.complexity) {
                            totalComplexity += sym.complexity;
                            complexityCount++;
                        }
                    }

                    if (complexityCount > 0) {
                        data.avgComplexity = totalComplexity / complexityCount;
                    }
                    data.symbolCount = symbols.length;
                }

            } else if (nodeType === 'symbol') {
                // Format: filePath:symbolName:line
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = parts.slice(0, -2).join(':');

                    data.name = symbolName;
                    data.path = `${filePath}:${line}`;

                    const symbols = this.db.getSymbolsByFile(filePath);
                    const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

                    if (symbol) {
                        data.lines = (symbol.rangeEndLine - symbol.rangeStartLine) + 1;
                        data.complexity = symbol.complexity;

                        const incoming = this.db.getIncomingEdges(symbol.id);
                        const outgoing = this.db.getOutgoingEdges(symbol.id);

                        data.fanIn = incoming.length;
                        data.fanOut = outgoing.length;
                    }
                }
            }
        } catch (error) {
            console.error('Error fetching overview:', error);
        }

        return data;
    }

    /**
     * Get dependencies for a node
     */
    async getDependencies(nodeId: string, nodeType: 'domain' | 'file' | 'symbol'): Promise<InspectorDependencyData> {
        const result: InspectorDependencyData = {
            calls: [],
            calledBy: [],
            imports: [],
            usedBy: []
        };

        try {
            if (nodeType === 'symbol') {
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = parts.slice(0, -2).join(':');

                    const symbols = this.db.getSymbolsByFile(filePath);
                    const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

                    if (symbol) {
                        const outgoing = this.db.getOutgoingEdges(symbol.id);
                        for (const edge of outgoing) {
                            const target = this.db.getSymbolById(edge.targetId);
                            if (target) {
                                result.calls.push(this.mapSymbolToDep(target));
                            }
                        }

                        const incoming = this.db.getIncomingEdges(symbol.id);
                        for (const edge of incoming) {
                            const source = this.db.getSymbolById(edge.sourceId);
                            if (source) {
                                result.calledBy.push(this.mapSymbolToDep(source));
                            }
                        }
                    }
                }
            } else if (nodeType === 'file') {
                let filePath = nodeId;
                if (filePath.startsWith('domain:')) {
                    filePath = filePath.substring(7);
                }

                // Get all symbols in this file
                const symbols = this.db.getSymbolsByFile(filePath);
                const fileSymbolIds = new Set(symbols.map(s => s.id));

                const importsMap = new Map<string, InspectorDependencyItem>();
                const usedByMap = new Map<string, InspectorDependencyItem>();

                for (const sym of symbols) {
                    // Outgoing edges (Imports)
                    const outgoing = this.db.getOutgoingEdges(sym.id);
                    for (const edge of outgoing) {
                        if (!fileSymbolIds.has(edge.targetId)) {
                            const target = this.db.getSymbolById(edge.targetId);
                            if (target) {
                                const item = this.mapSymbolToDep(target);
                                importsMap.set(item.id, item);
                            }
                        }
                    }

                    // Incoming edges (Used By)
                    const incoming = this.db.getIncomingEdges(sym.id);
                    for (const edge of incoming) {
                        if (!fileSymbolIds.has(edge.sourceId)) {
                            const source = this.db.getSymbolById(edge.sourceId);
                            if (source) {
                                const item = this.mapSymbolToDep(source);
                                usedByMap.set(item.id, item);
                            }
                        }
                    }
                }

                result.imports = Array.from(importsMap.values());
                result.usedBy = Array.from(usedByMap.values());
            }
        } catch (error) {
            console.error('Error fetching dependencies:', error);
        }

        return result;
    }

    private mapSymbolToDep(symbol: any): InspectorDependencyItem {
        return {
            id: `${symbol.filePath}:${symbol.name}:${symbol.rangeStartLine}`,
            name: symbol.name,
            type: symbol.type,
            filePath: symbol.filePath
        };
    }

    /**
     * Get risks for a node
     */
    async getRisks(nodeId: string, nodeType: 'domain' | 'file' | 'symbol'): Promise<InspectorRiskData> {
        let level: 'low' | 'medium' | 'high' = 'low';
        let heatScore = 0;
        const warnings: string[] = [];

        try {
            if (nodeType === 'symbol') {
                const parts = nodeId.split(':');
                if (parts.length >= 3) {
                    const line = parseInt(parts[parts.length - 1], 10);
                    const symbolName = parts[parts.length - 2];
                    const filePath = parts.slice(0, -2).join(':');

                    const symbols = this.db.getSymbolsByFile(filePath);
                    const symbol = symbols.find(s => s.name === symbolName && s.rangeStartLine === line);

                    if (symbol) {
                        if (symbol.complexity > 15) {
                            warnings.push(`High complexity (${symbol.complexity})`);
                            heatScore += 30;
                        }

                        const incoming = this.db.getIncomingEdges(symbol.id).length;
                        if (incoming > 20) {
                            warnings.push(`High coupling (called by ${incoming} symbols)`);
                            heatScore += 20;
                        }
                    }
                }
            }

            if (heatScore > 60) level = 'high';
            else if (heatScore > 30) level = 'medium';

        } catch (error) {
            console.error('Error calculation risks:', error);
        }

        return { level, heatScore, warnings };
    }

    /**
     * Execute AI Action
     */
    async executeAIAction(
        nodeId: string,
        action: 'explain' | 'audit' | 'refactor' | 'dependencies' | 'optimize'
    ): Promise<InspectorAIResult> {

        let prompt = '';
        let analysisType: any = 'general';

        if (action === 'refactor') analysisType = 'refactor';
        else if (action === 'audit') analysisType = 'security';
        else if (action === 'dependencies') analysisType = 'dependencies';

        // Build prompt based on action
        if (action === 'explain') prompt = `Explain the code at ${nodeId}`;
        else if (action === 'audit') prompt = `Audit the code at ${nodeId} for security and bugs`;
        else if (action === 'refactor') prompt = `Refactor the code at ${nodeId} to improve quality using best practices`;
        else if (action === 'optimize') prompt = `Optimize the code at ${nodeId} for performance`;
        else if (action === 'dependencies') prompt = `Analyze dependencies for ${nodeId}`;

        try {
            // Use orchestrator to process
            // Note: In real app, we'd pass the symbol ID to orchestrator to fetch context
            const result = await this.orchestrator.processQuery(prompt, {
                analysisType
            });

            // Check for diff blocks if refactor
            let patch = undefined;
            if (action === 'refactor' && result.content.includes('```diff')) {
                const diffMatch = result.content.match(/```diff\n([\s\S]*?)```/);
                if (diffMatch) {
                    patch = {
                        summary: 'AI Suggested Refactor',
                        impactedNodeCount: 1, // approximate
                        diff: diffMatch[1]
                    };
                }
            }

            return {
                action,
                content: result.content,
                model: 'groq', // Placeholder, orchestrator should return model used
                cached: false,
                loading: false,
                patch
            };

        } catch (error) {
            return {
                action,
                content: '',
                model: 'groq',
                cached: false,
                loading: false,
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    /**
     * Explain why a risk is high/medium
     */
    async explainRisk(nodeId: string, metric: string): Promise<string> {
        const prompt = `Explain why the risk metric "${metric}" is applicable to ${nodeId}. What factors contribute to this risk?`;

        try {
            const result = await this.orchestrator.processQuery(prompt, {
                analysisType: 'general'
            });
            return result.content;
        } catch (error) {
            return `Failed to explain risk: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
}
