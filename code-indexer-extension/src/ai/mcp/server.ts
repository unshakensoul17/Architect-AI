// Purpose: MCP Server implementation
// Provides read-only access to the SQLite database via defined tools
// AI models can only access data through these strictly defined interfaces

import { CodeIndexDatabase } from '../../db/database';
import {
    GetSymbolInput,
    GetSymbolResult,
    GetDependenciesInput,
    GetDependenciesResult,
    ClassifyDomainInput,
    ClassifyDomainResult,
    isValidMCPTool,
    mcpToolDefinitions
} from './tools';
import { DomainClassifier } from '../../domain/classifier';

/**
 * MCP Tool call request
 */
export interface MCPToolCall {
    toolName: string;
    arguments: Record<string, unknown>;
}

/**
 * MCP Tool call response
 */
export interface MCPToolResponse {
    success: boolean;
    toolName: string;
    result?: unknown;
    error?: string;
}

/**
 * MCP Server - Exposes read-only database access via tools
 * 
 * Following Model Context Protocol specification:
 * - Tools are the primary way AI can interact with the database
 * - All operations are read-only (no mutations)
 * - Strict input validation
 */
export class MCPServer {
    private db: CodeIndexDatabase;
    private domainClassifier: DomainClassifier;

    constructor(db: CodeIndexDatabase) {
        this.db = db;
        this.domainClassifier = new DomainClassifier();
    }

    /**
     * Get available tools for LLM
     * Returns tool definitions in MCP format
     */
    getAvailableTools() {
        return mcpToolDefinitions;
    }

    /**
     * Execute a tool call
     */
    async executeTool(call: MCPToolCall): Promise<MCPToolResponse> {
        if (!isValidMCPTool(call.toolName)) {
            return {
                success: false,
                toolName: call.toolName,
                error: `Unknown tool: ${call.toolName}. Available tools: get_symbol, get_dependencies, classify_domain`,
            };
        }

        try {
            switch (call.toolName) {
                case 'get_symbol':
                    return {
                        success: true,
                        toolName: call.toolName,
                        result: this.executeGetSymbol(call.arguments as GetSymbolInput & { includeContext?: boolean }),
                    };

                case 'get_dependencies':
                    return {
                        success: true,
                        toolName: call.toolName,
                        result: this.executeGetDependencies(call.arguments as unknown as GetDependenciesInput),
                    };

                case 'classify_domain':
                    return {
                        success: true,
                        toolName: call.toolName,
                        result: this.executeClassifyDomain(call.arguments as unknown as ClassifyDomainInput),
                    };

                default:
                    return {
                        success: false,
                        toolName: call.toolName,
                        error: 'Tool not implemented',
                    };
            }
        } catch (error) {
            return {
                success: false,
                toolName: call.toolName,
                error: `Tool execution failed: ${(error as Error).message}`,
            };
        }
    }

    /**
     * Execute get_symbol tool
     */
    private executeGetSymbol(input: GetSymbolInput & { includeContext?: boolean }): GetSymbolResult {
        let symbol = null;

        if (input.symbolId !== undefined) {
            symbol = this.db.getSymbolById(input.symbolId);
        } else if (input.name) {
            symbol = this.db.getSymbolByName(input.name);
        }

        if (!symbol) {
            return {
                success: false,
                error: input.symbolId !== undefined
                    ? `Symbol with ID ${input.symbolId} not found`
                    : `Symbol with name "${input.name}" not found`,
            };
        }

        // Optionally include context (neighbors)
        if (input.includeContext) {
            const context = this.db.getSymbolWithContext(symbol.id);
            return {
                success: true,
                symbol,
                context: context || undefined,
            };
        }

        return {
            success: true,
            symbol,
        };
    }

    /**
     * Execute get_dependencies tool
     */
    private executeGetDependencies(input: GetDependenciesInput): GetDependenciesResult {
        const direction = input.direction || 'both';

        // Verify symbol exists
        const symbol = this.db.getSymbolById(input.symbolId);
        if (!symbol) {
            return {
                success: false,
                symbolId: input.symbolId,
                error: `Symbol with ID ${input.symbolId} not found`,
            };
        }

        const deps = this.db.getDependencies(input.symbolId, direction);

        return {
            success: true,
            symbolId: input.symbolId,
            incoming: direction === 'incoming' || direction === 'both' ? deps.incoming : undefined,
            outgoing: direction === 'outgoing' || direction === 'both' ? deps.outgoing : undefined,
        };
    }

    /**
     * Execute classify_domain tool
     */
    private executeClassifyDomain(input: ClassifyDomainInput): ClassifyDomainResult {
        try {
            // Use heuristic classifier
            const classification = this.domainClassifier.classify(
                input.filePath,
                input.imports,
                input.symbolName
            );

            return {
                success: true,
                domain: classification.domain,
                confidence: classification.confidence,
                reasoning: classification.reason,
            };
        } catch (error) {
            return {
                success: false,
                error: `Domain classification failed: ${(error as Error).message}`,
            };
        }
    }

    /**
     * Format tool results for inclusion in AI prompts
     */
    formatToolResultForPrompt(response: MCPToolResponse): string {
        if (!response.success) {
            return `Tool Error: ${response.error}`;
        }

        const result = response.result;
        if (!result) {
            return 'No result returned';
        }

        // Format based on tool type
        if (response.toolName === 'get_symbol') {
            const sr = result as GetSymbolResult;
            if (sr.symbol) {
                let output = `Symbol: ${sr.symbol.name} (${sr.symbol.type})\n`;
                output += `File: ${sr.symbol.filePath}\n`;
                output += `Lines: ${sr.symbol.rangeStartLine}-${sr.symbol.rangeEndLine}\n`;

                if (sr.context?.neighbors && sr.context.neighbors.length > 0) {
                    output += `\nNeighboring Symbols (${sr.context.neighbors.length}):\n`;
                    sr.context.neighbors.forEach(n => {
                        output += `  - ${n.name} (${n.type}) in ${n.filePath}\n`;
                    });
                }
                return output;
            }
        }

        if (response.toolName === 'get_dependencies') {
            const dr = result as GetDependenciesResult;
            let output = `Dependencies for symbol ID ${dr.symbolId}:\n`;

            if (dr.outgoing && dr.outgoing.length > 0) {
                output += `\nOutgoing (depends on, ${dr.outgoing.length}):\n`;
                dr.outgoing.forEach(d => {
                    output += `  → ${d.symbol.name} (${d.edge.type})\n`;
                });
            }

            if (dr.incoming && dr.incoming.length > 0) {
                output += `\nIncoming (depended by, ${dr.incoming.length}):\n`;
                dr.incoming.forEach(d => {
                    output += `  ← ${d.symbol.name} (${d.edge.type})\n`;
                });
            }

            return output;
        }

        if (response.toolName === 'classify_domain') {
            const cr = result as ClassifyDomainResult;
            if (cr.domain) {
                let output = `Domain Classification:\n`;
                output += `Domain: ${cr.domain}\n`;
                output += `Confidence: ${((cr.confidence || 0) * 100).toFixed(0)}%\n`;
                if (cr.reasoning) {
                    output += `Reasoning: ${cr.reasoning}\n`;
                }
                return output;
            }
        }

        return JSON.stringify(result, null, 2);
    }
}
