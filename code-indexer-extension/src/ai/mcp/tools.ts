// Purpose: MCP (Model Context Protocol) tool definitions
// Exposes read-only database access for AI models
// Tools: get_symbol, get_dependencies

import { Symbol, Edge, SymbolContext } from '../../db/schema';

/**
 * MCP Tool input schema types
 */
export interface GetSymbolInput {
    symbolId?: number;
    name?: string;
}

export interface GetDependenciesInput {
    symbolId: number;
    direction?: 'incoming' | 'outgoing' | 'both';
}

/**
 * MCP Tool result types
 */
export interface GetSymbolResult {
    success: boolean;
    symbol?: Symbol;
    context?: SymbolContext;
    error?: string;
}

export interface GetDependenciesResult {
    success: boolean;
    symbolId: number;
    incoming?: { edge: Edge; symbol: Symbol }[];
    outgoing?: { edge: Edge; symbol: Symbol }[];
    error?: string;
}

/**
 * MCP Tool definitions following Model Context Protocol spec
 * These are read-only tools that AI can use to query the code index
 */
export const mcpToolDefinitions = [
    {
        name: 'get_symbol',
        description: 'Get a code symbol by name or ID. Returns symbol details including file path, type, and location. Optionally includes 1st-degree neighbor context.',
        inputSchema: {
            type: 'object',
            properties: {
                symbolId: {
                    type: 'number',
                    description: 'The unique ID of the symbol to retrieve',
                },
                name: {
                    type: 'string',
                    description: 'The name of the symbol to search for',
                },
                includeContext: {
                    type: 'boolean',
                    description: 'If true, includes neighboring symbols (1st-degree connections)',
                    default: false,
                },
            },
            oneOf: [
                { required: ['symbolId'] },
                { required: ['name'] },
            ],
        },
    },
    {
        name: 'get_dependencies',
        description: 'Get incoming and/or outgoing dependencies for a symbol. Incoming = what depends on this symbol. Outgoing = what this symbol depends on.',
        inputSchema: {
            type: 'object',
            properties: {
                symbolId: {
                    type: 'number',
                    description: 'The unique ID of the symbol to get dependencies for',
                },
                direction: {
                    type: 'string',
                    enum: ['incoming', 'outgoing', 'both'],
                    description: 'Which direction of dependencies to fetch',
                    default: 'both',
                },
            },
            required: ['symbolId'],
        },
    },
];

/**
 * Tool name type for type-safe tool calls
 */
export type MCPToolName = 'get_symbol' | 'get_dependencies';

/**
 * Validate if a tool name is a valid MCP tool
 */
export function isValidMCPTool(toolName: string): toolName is MCPToolName {
    return toolName === 'get_symbol' || toolName === 'get_dependencies';
}

/**
 * Get tool definition by name
 */
export function getToolDefinition(toolName: MCPToolName) {
    return mcpToolDefinitions.find(t => t.name === toolName);
}
