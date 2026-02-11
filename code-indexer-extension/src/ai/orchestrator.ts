// Purpose: Main AI Orchestrator
// Wires together intent routing, context assembly, and model clients
// Routes queries to appropriate AI model based on intent classification

import { IntentRouter, ClassifiedIntent } from './intent-router';
import { GroqClient, createGroqClient } from './groq-client';
import { VertexClient, createVertexClient } from './vertex-client';
import { GeminiClient, createGeminiClient } from './gemini-client';
import { MCPServer, MCPToolCall, MCPToolResponse } from './mcp/server';
import { CodeIndexDatabase } from '../db/database';
import { SymbolContext } from '../db/schema';
import { DomainClassification, DomainType } from '../domain/classifier';
import { DOMAIN_DESCRIPTIONS } from './mcp/domain-tools';
import * as fs from 'fs';
import { StructuralSkeleton } from '../worker/parser';

/**
 * Refined metadata from Architect Pass
 */
export interface RefinedNodeData {
    id: string; // matches format used in graph
    purpose: string;
    impact_depth: number;
    search_tags: string[]; // will be serialized to JSON in DB
    fragility: string;
}

export interface RefinedEdgeData {
    sourceId: string;
    targetId: string;
    reason: string;
}

export interface RefinedGraph {
    nodes: Record<string, RefinedNodeData>;
    implicit_links: RefinedEdgeData[];
}

/**
 * AI Response from the orchestrator
 */
export interface AIResponse {
    content: string;
    model: string;
    intent: ClassifiedIntent;
    latencyMs: number;
    contextIncluded: boolean;
    neighborCount?: number;
}

/**
 * AI Query options
 */
export interface AIQueryOptions {
    symbolId?: number;
    symbolName?: string;
    includeContext?: boolean;
    analysisType?: 'security' | 'refactor' | 'dependencies' | 'general';
}

/**
 * AI Orchestrator - Main controller for AI-powered code analysis
 * 
 * Intent Routing:
 * - Reflex Path (Groq/Llama 3.1): Fast <300ms responses for simple queries
 * - Strategic Path (Vertex AI/Gemini 1.5 Pro): Deep analysis for complex queries
 * 
 * Context Assembly (cAST):
 * - Fetches target symbol + 1st-degree neighbors from SQLite
 * - Packages code context into AI prompts
 * 
 * MCP Integration:
 * - Exposes database as tools for AI access
 * - Read-only, strictly defined interfaces
 */
export class AIOrchestrator {
    private intentRouter: IntentRouter;
    private groqClient: GroqClient | null;
    private vertexClient: VertexClient | null;
    private geminiClient: GeminiClient | null;
    private mcpServer: MCPServer;
    private db: CodeIndexDatabase;

    constructor(db: CodeIndexDatabase) {
        this.db = db;
        this.intentRouter = new IntentRouter();
        this.mcpServer = new MCPServer(db);

        // Initialize AI clients (will be null if API keys not available)
        this.groqClient = createGroqClient();
        this.vertexClient = createVertexClient();
        this.geminiClient = createGeminiClient();
    }

    /**
     * Process an AI query with automatic routing
     */
    async processQuery(query: string, options: AIQueryOptions = {}): Promise<AIResponse> {
        const startTime = performance.now();

        // 1. Classify intent
        const intent = this.intentRouter.classify(query);
        console.log(`[Orchestrator] Intent: ${intent.type} (confidence: ${intent.confidence.toFixed(2)})`);

        // 2. Assemble context if symbol provided
        let context: SymbolContext | null = null;
        let codeSnippets: string[] = [];

        if (options.symbolId || options.symbolName) {
            context = await this.assembleContext(options);
            if (context) {
                codeSnippets = await this.extractCodeSnippets(context);
            }
        }

        // 3. Build prompt with context
        const prompt = this.buildPrompt(query, context, codeSnippets);

        // 4. Check Cache
        let cacheHash: string | null = null;
        if (context) {
            cacheHash = this.computeCacheHash(query, codeSnippets, options.analysisType);
            const cachedEntry = this.db.getAICache(cacheHash);
            if (cachedEntry) {
                try {
                    const cachedResponse = JSON.parse(cachedEntry.response) as AIResponse;
                    console.log(`[Orchestrator] Cache hit for hash ${cacheHash.substring(0, 8)}`);
                    cachedResponse.latencyMs = 0; // Reset latency for cache hit
                    return cachedResponse;
                } catch (error) {
                    console.error('Failed to parse cached response:', error);
                }
            }
        }

        // 5. Route to appropriate model
        let response: AIResponse;

        if (intent.type === 'reflex') {
            response = await this.executeReflexPath(prompt, intent, context);
        } else {
            response = await this.executeStrategicPath(
                prompt,
                intent,
                context,
                codeSnippets,
                options.analysisType || 'general'
            );
        }

        const endTime = performance.now();
        response.latencyMs = Math.round(endTime - startTime);

        // 6. Cache Response
        if (cacheHash && response.model !== 'none') {
            this.db.setAICache(cacheHash, JSON.stringify(response));
        }

        return response;
    }

    /**
     * Compute cache hash based on query, code context, and analysis type
     */
    private computeCacheHash(query: string, codeSnippets: string[], analysisType?: string): string {
        const str = JSON.stringify({
            query,
            codeSnippets,
            analysisType: analysisType || 'general'
        });
        return CodeIndexDatabase.computeHash(str);
    }

    /**
     * Assemble context from database
     */
    private async assembleContext(options: AIQueryOptions): Promise<SymbolContext | null> {
        let symbolId = options.symbolId;

        // Resolve symbol by name if needed
        if (!symbolId && options.symbolName) {
            const symbol = this.db.getSymbolByName(options.symbolName);
            if (symbol) {
                symbolId = symbol.id;
            }
        }

        if (!symbolId) {
            return null;
        }

        return this.db.getSymbolWithContext(symbolId);
    }

    /**
     * Extract code snippets from context
     * In a real implementation, this would read actual file contents
     */
    private async extractCodeSnippets(context: SymbolContext): Promise<string[]> {
        const snippets: string[] = [];

        // Helper to read code from file
        const readSymbolCode = (symbol: { filePath: string; rangeStartLine: number; rangeEndLine: number }): string => {
            try {
                if (!fs.existsSync(symbol.filePath)) {
                    return `// File not found: ${symbol.filePath}`;
                }
                const content = fs.readFileSync(symbol.filePath, 'utf-8');
                const lines = content.split('\n');
                const start = Math.max(0, symbol.rangeStartLine - 1);
                const end = Math.min(lines.length, symbol.rangeEndLine);
                return lines.slice(start, end).join('\n');
            } catch (error) {
                return `// Error reading file: ${(error as Error).message}`;
            }
        };

        // Extract neighbor code snippets
        for (const neighbor of context.neighbors) {
            const code = readSymbolCode(neighbor);
            snippets.push(`// ${neighbor.name} (${neighbor.type}) from ${neighbor.filePath}\n${code}`);
        }

        console.log(`[Orchestrator] Extracted ${snippets.length} neighbor code snippets`);
        return snippets;
    }

    /**
     * Build prompt with context
     */
    private buildPrompt(query: string, context: SymbolContext | null, neighborCode: string[]): string {
        let prompt = '';

        if (context) {
            prompt += `## Target Symbol\n`;
            prompt += `Name: ${context.symbol.name}\n`;
            prompt += `Type: ${context.symbol.type}\n`;
            prompt += `File: ${context.symbol.filePath}\n`;
            prompt += `Lines: ${context.symbol.rangeStartLine}-${context.symbol.rangeEndLine}\n\n`;

            if (neighborCode.length > 0) {
                prompt += `## Related Code (${neighborCode.length} neighbors)\n`;
                neighborCode.forEach((code, i) => {
                    prompt += `\n### Neighbor ${i + 1}\n\`\`\`\n${code}\n\`\`\`\n`;
                });
                prompt += '\n';
            }
        }

        prompt += `## Question\n${query}`;

        return prompt;
    }

    /**
     * Execute reflex path (Groq/Llama 3.1)
     */
    private async executeReflexPath(
        prompt: string,
        intent: ClassifiedIntent,
        context: SymbolContext | null
    ): Promise<AIResponse> {
        if (!this.groqClient) {
            return {
                content: 'Groq client not available. Please set GROQ_API_KEY environment variable.',
                model: 'none',
                intent,
                latencyMs: 0,
                contextIncluded: !!context,
                neighborCount: context?.neighbors.length,
            };
        }

        const systemPrompt = `You are a code assistant providing quick, concise explanations.
Keep responses brief and focused on the question asked.
If there's related code context provided, reference it when relevant.`;

        const response = await this.groqClient.complete(prompt, systemPrompt);

        return {
            content: response.content,
            model: response.model,
            intent,
            latencyMs: response.latencyMs,
            contextIncluded: !!context,
            neighborCount: context?.neighbors.length,
        };
    }

    /**
     * Execute strategic path (Vertex AI/Gemini 1.5 Pro)
     */
    private async executeStrategicPath(
        _prompt: string,  // Prompt kept for future use with alternative models
        intent: ClassifiedIntent,
        context: SymbolContext | null,
        neighborCode: string[],
        analysisType: 'security' | 'refactor' | 'dependencies' | 'general'
    ): Promise<AIResponse> {
        if (!this.vertexClient) {
            return {
                content: 'Vertex AI client not available. Please set GOOGLE_CLOUD_PROJECT environment variable.',
                model: 'none',
                intent,
                latencyMs: 0,
                contextIncluded: !!context,
                neighborCount: context?.neighbors.length,
            };
        }

        // For strategic analysis, extract target code too
        let targetCode = '';
        if (context) {
            try {
                const content = fs.readFileSync(context.symbol.filePath, 'utf-8');
                const lines = content.split('\n');
                const start = Math.max(0, context.symbol.rangeStartLine - 1);
                const end = Math.min(lines.length, context.symbol.rangeEndLine);
                targetCode = lines.slice(start, end).join('\n');
            } catch {
                targetCode = '// Could not read target code';
            }
        }

        const response = await this.vertexClient.analyzeCode(
            targetCode,
            neighborCode,
            analysisType,
            intent.query
        );

        return {
            content: response.content,
            model: response.model,
            intent,
            latencyMs: response.latencyMs,
            contextIncluded: !!context,
            neighborCount: context?.neighbors.length,
        };
    }

    /**
     * Execute MCP tool call
     */
    async executeMCPTool(call: MCPToolCall): Promise<MCPToolResponse> {
        return this.mcpServer.executeTool(call);
    }

    /**
     * Get available MCP tools
     */
    getMCPTools() {
        return this.mcpServer.getAvailableTools();
    }

    /**
     * Check if Groq client is available
     */
    hasGroqClient(): boolean {
        return this.groqClient !== null;
    }

    /**
     * Check if Vertex AI client is available
     */
    hasVertexClient(): boolean {
        return this.vertexClient !== null;
    }

    /**
     * Classify symbol domain using AI
     * Uses Groq for fast classification or falls back to heuristics
     */
    async classifySymbolDomain(
        symbolName: string,
        filePath: string,
        imports: string[]
    ): Promise<DomainClassification> {
        // Check if AI clients are available
        if (!this.groqClient && !this.vertexClient) {
            console.warn('[Orchestrator] No AI clients available for domain classification');
            // Return a low-confidence unknown classification to trigger fallback
            return {
                domain: DomainType.UNKNOWN,
                confidence: 0,
                reason: 'AI unavailable',
            };
        }

        try {
            // Build classification prompt
            const domainsList = Object.entries(DOMAIN_DESCRIPTIONS)
                .map(([domain, desc]) => `- ${domain}: ${desc}`)
                .join('\n');

            const prompt = `Analyze this code symbol and classify it into ONE of these architectural domains:

${domainsList}

Symbol Information:
- Name: ${symbolName}
- File Path: ${filePath}
- Imports: ${imports.length > 0 ? imports.join(', ') : 'none'}

Return ONLY a JSON object with this structure:
{
  "domain": "domain_name",
  "confidence": 0.0-1.0,
  "reasoning": "brief explanation"
}

Choose the most appropriate domain based on the symbol's purpose and context.`;

            let responseText = '';

            // Try Groq first (fast)
            if (this.groqClient) {
                try {
                    const systemPrompt = 'You are a code architecture expert. Always respond with valid JSON only.';
                    const response = await this.groqClient.complete(prompt, systemPrompt);
                    responseText = response.content;
                } catch (error) {
                    console.warn('[Orchestrator] Groq classification failed:', (error as Error).message);
                }
            }

            // Fallback to Vertex if Groq failed
            if (!responseText && this.vertexClient) {
                try {
                    const systemPrompt = 'You are a code architecture expert. Always respond with valid JSON only.';
                    const response = await this.vertexClient.complete(prompt, systemPrompt);
                    responseText = response.content;
                } catch (error) {
                    console.warn('[Orchestrator] Vertex classification failed:', (error as Error).message);
                }
            }

            // Parse AI response
            if (responseText) {
                // Extract JSON from response (in case there's extra text)
                const jsonMatch = responseText.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const parsed = JSON.parse(jsonMatch[0]);
                    return {
                        domain: parsed.domain as DomainType,
                        confidence: parsed.confidence || 0.8,
                        reason: parsed.reasoning || 'AI classified',
                    };
                }
            }

            // If AI failed, return low confidence to trigger heuristic fallback
            return {
                domain: DomainType.UNKNOWN,
                confidence: 0,
                reason: 'AI parsing failed',
            };
        } catch (error) {
            console.error('[Orchestrator] Domain classification error:', error);
            return {
                domain: DomainType.UNKNOWN,
                confidence: 0,
                reason: `Error: ${(error as Error).message}`,
            };
        }
    }

    /**
     * Get intent classification without executing query
     */
    classifyIntent(query: string): ClassifiedIntent {
        return this.intentRouter.classify(query);
    }
    /**
     * Update AI client configuration
     */
    updateConfig(config: { vertexProject?: string; groqApiKey?: string; geminiApiKey?: string }) {
        if (config.groqApiKey) {
            console.log('[Orchestrator] Updating Groq client with new API key');
            this.groqClient = createGroqClient({ apiKey: config.groqApiKey });
        }

        if (config.vertexProject) {
            console.log('[Orchestrator] Updating Vertex AI client with new project ID');
            this.vertexClient = createVertexClient({ projectId: config.vertexProject });
        }

        if (config.geminiApiKey) {
            console.log('[Orchestrator] Updating Gemini client with new API key');
            this.geminiClient = createGeminiClient({ apiKey: config.geminiApiKey });
        }
    }
    // } removed to keep methods inside class

    /**
     * Architect Pass: Refine system graph using Gemini 1.5 Pro
     * Sends structural skeleton to AI to infer purpose, impact, and implicit links
     */
    async refineSystemGraph(skeleton: Record<string, StructuralSkeleton>): Promise<RefinedGraph> {
        if (!this.vertexClient && !this.geminiClient) {
            throw new Error('Gemini or Vertex AI client not initialized (Project ID or API Key missing)');
        }

        const client = this.geminiClient || this.vertexClient!;

        const methodStartTime = performance.now();
        const skeletonJson = JSON.stringify(skeleton, null, 2);

        // Check Cache (Critical for cost saving)
        // We use a specific prefix for architect pass
        const cacheKey = `architect_pass_v1:${CodeIndexDatabase.computeHash(skeletonJson)}`;
        const cachedEntry = this.db.getAICache(cacheKey);

        if (cachedEntry) {
            console.log(`[Orchestrator] Architect Pass cache hit`);
            try {
                const result = JSON.parse(cachedEntry.response);
                return result as RefinedGraph;
            } catch (e) {
                console.error('[Orchestrator] Failed to parse cached architect result', e);
            }
        }

        console.log(`[Orchestrator] Starting Architect Pass with ${client.getModel()} (${skeletonJson.length} bytes)`);

        const systemPrompt = `You are a Principal Software Architect. 
Analyze the provided Codebase Structural Skeleton (JSON).
Your goal is to infer high-level metadata that cannot be statically analyzed.

For every relevant Node (Function/Class), infer:
1. "purpose": A concise 1-sentence description of what it does.
2. "impact_depth": Integer 1-10. 1=Local utility, 10=System core/critical path.
3. "search_tags": Array of strings. Concepts/Business-logic terms (e.g., "auth", "payment", "user-flow").
4. "fragility": "high", "medium", "low". specific logic that looks brittle or complex.

Also identify "implicit_links":
Dependencies that are not explicit imports (e.g., events, dynamic calls, framework configuration).

Return a JSON object EXACTLY matching this interface:
{
  "nodes": {
    "node_id_from_skeleton": {
      "purpose": "...",
      "impact_depth": 5,
      "search_tags": ["tag1", "tag2"],
      "fragility": "low"
    }
  },
  "implicit_links": [
    { "sourceId": "...", "targetId": "...", "reason": "..." }
  ]
}

IMPORTANT:
- Use the exact IDs provided in the skeleton if possible, or construct them as "filePath:name:line".
- The input skeleton uses "startLine" which usually maps to the ID format.
- Be consistent with ID generation.
- Return ONLY VALID JSON.
`;

        const prompt = `Here is the Structural Skeleton of the codebase:\n\n\`\`\`json\n${skeletonJson}\n\`\`\``;

        try {
            const response = await client.complete(prompt, systemPrompt);
            const content = response.content;

            // Log thoughts if provided (Gemini 2.0/3.0 thinking feature)
            if ((response as any).thought) {
                console.log(`[Orchestrator] AI Architect Thought process:\n${(response as any).thought}`);
            }

            // Extract JSON
            const jsonMatch = content.match(/\{[\s\S]*\}/);
            if (!jsonMatch) {
                throw new Error('No JSON found in Architect response');
            }

            const refinedGraph = JSON.parse(jsonMatch[0]) as RefinedGraph;

            // Cache the result
            this.db.setAICache(cacheKey, JSON.stringify(refinedGraph));

            console.log(`[Orchestrator] Architect Pass completed in ${Math.round(performance.now() - methodStartTime)}ms`);

            return refinedGraph;
        } catch (error) {
            console.error('[Orchestrator] Architect Pass failed:', error);
            throw error;
        }
    }

    /**
     * Reflex Pass: Get instant insight for a node using Groq (Llama 3.1)
     * Target latency < 200ms
     */
    async getNodeInsight(nodeMetadata: any, question: string): Promise<string> {
        if (!this.groqClient) {
            return "AI Insight unavailable (Groq key missing)";
        }

        const context = JSON.stringify({
            name: nodeMetadata.name,
            type: nodeMetadata.type,
            purpose: nodeMetadata.purpose,
            tags: nodeMetadata.search_tags,
            fragility: nodeMetadata.fragility
        });

        const prompt = `Node Context: ${context}\n\nQuestion: ${question}\n\nAnswer concisely (under 20 words):`;
        const systemPrompt = "You are a coding expert. Be extremely concise.";

        try {
            const response = await this.groqClient.complete(prompt, systemPrompt);
            return response.content;
        } catch (error) {
            console.warn('[Orchestrator] Reflex pass failed:', error);
            return "Insight generation failed.";
        }
    }
}

/**
 * Create an AI orchestrator instance
 */
export function createOrchestrator(db: CodeIndexDatabase): AIOrchestrator {
    return new AIOrchestrator(db);
}
