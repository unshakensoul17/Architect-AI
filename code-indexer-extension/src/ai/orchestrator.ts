// Purpose: Main AI Orchestrator
// Wires together intent routing, context assembly, and model clients
// Routes queries to appropriate AI model based on intent classification

import { IntentRouter, ClassifiedIntent } from './intent-router';
import { GroqClient, createGroqClient } from './groq-client';
import { VertexClient, createVertexClient } from './vertex-client';
import { GeminiClient, createGeminiClient } from './gemini-client';
import { CodeIndexDatabase } from '../db/database';
import { SymbolContext } from '../db/schema';
import { DomainClassification, DomainType } from '../domain/classifier';
import * as fs from 'fs';

/**
 * Refined metadata from Architect Pass
 */
export interface RefinedNodeData {
    id: string; // matches format used in graph
    purpose: string;
    impact_depth: number;
    search_tags: string[]; // will be serialized to JSON in DB
    fragility: string;
    risk_score: number; // 0-100 AI-calculated risk severity
    risk_reason: string; // AI explanation (e.g. "If this fails, the Auth flow stops")
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

    private db: CodeIndexDatabase;

    constructor(db: CodeIndexDatabase) {
        this.db = db;
        this.intentRouter = new IntentRouter();


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
     * CRITICAL: Includes the TARGET symbol's code first, then neighbors
     * 
     * ENHANCED (Phase 2.2): Cross-File Summarization
     * If a neighbor already has an AI-generated `purpose` (from Architect Pass),
     * inject that 1-line summary instead of the full source code.
     * This dramatically reduces token usage while preserving architectural context.
     */
    private async extractCodeSnippets(context: SymbolContext): Promise<string[]> {
        const snippets: string[] = [];
        let summarizedCount = 0;
        let rawCount = 0;

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

        // TARGET symbol always gets full code — the AI needs to see what it's analyzing!
        const targetCode = readSymbolCode(context.symbol);
        snippets.push(`// TARGET: ${context.symbol.name} (${context.symbol.type})\n${targetCode}`);

        // Extract neighbor context — use summaries when available
        for (const neighbor of context.neighbors) {
            const neighborAny = neighbor as any;

            if (neighborAny.purpose && typeof neighborAny.purpose === 'string') {
                // Cross-File Summarization: use AI-generated purpose instead of raw code
                const fragility = neighborAny.fragility ? ` [fragility: ${neighborAny.fragility}]` : '';
                const domain = neighborAny.domain ? ` [${neighborAny.domain}]` : '';
                snippets.push(
                    `// RELATED: ${neighbor.name} (${neighbor.type})${domain}${fragility} — ${neighborAny.purpose}`
                );
                summarizedCount++;
            } else {
                // No AI summary yet — inject raw code
                const code = readSymbolCode(neighbor);
                snippets.push(`// RELATED: ${neighbor.name} (${neighbor.type}) from ${neighbor.filePath}\n${code}`);
                rawCount++;
            }
        }

        console.log(`[Orchestrator] Context: target code + ${summarizedCount} summarized + ${rawCount} raw neighbors`);
        return snippets;
    }

    /**
     * Build prompt with context
     * 
     * ENHANCED (Phase 2.1): Chain-of-Architectural-Thought
     * Instructs the AI to identify design patterns before answering,
     * producing richer architectural analysis instead of just code explanation.
     */
    private buildPrompt(query: string, context: SymbolContext | null, neighborCode: string[]): string {
        let prompt = '';

        if (context) {
            prompt += `## Target Symbol\n`;
            prompt += `Name: ${context.symbol.name}\n`;
            prompt += `Type: ${context.symbol.type}\n`;
            prompt += `File: ${context.symbol.filePath}\n`;
            prompt += `Lines: ${context.symbol.rangeStartLine}-${context.symbol.rangeEndLine}\n\n`;

            // Include AI-enriched metadata if available
            const symbolAny = context.symbol as any;
            if (symbolAny.purpose) {
                prompt += `Purpose: ${symbolAny.purpose}\n`;
            }
            if (symbolAny.fragility) {
                prompt += `Fragility: ${symbolAny.fragility}\n`;
            }
            if (symbolAny.impactDepth) {
                prompt += `Impact Depth: ${symbolAny.impactDepth}/10\n`;
            }
            prompt += '\n';

            if (neighborCode.length > 0) {
                prompt += `## Related Code (${neighborCode.length} neighbors)\n`;
                neighborCode.forEach((code, i) => {
                    prompt += `\n### Neighbor ${i + 1}\n\`\`\`\n${code}\n\`\`\`\n`;
                });
                prompt += '\n';
            }

            // Chain-of-Architectural-Thought: ask AI to identify patterns first
            prompt += `## Architectural Analysis\n`;
            prompt += `Before answering, identify the architectural pattern(s) `;
            prompt += `used in this code (e.g., Factory, Singleton, Observer, `;
            prompt += `Middleware, Repository, CQRS, Event-Driven, Strategy, Decorator). `;
            prompt += `State the pattern(s), then answer in that context.\n\n`;
        }

        prompt += `## Question\n${query}`;

        return prompt;
    }

    /**
     * Execute reflex path (Groq/Llama 3.1)
     * Optimized for speed but now allows technical detail
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

        // **FIX 3: LOOSEN CONSTRAINTS FOR DEEP ANALYSIS**
        // Allow more detail when we have context (Inspector panel)
        // Keep it brief for quick queries without context
        const systemPrompt = context
            ? `You are a code analysis expert. Provide clear, technical explanations.
When analyzing code, explain:
- What it does
- How it works (key logic)
- Potential issues or improvements

Be concise but thorough - aim for 50-150 words for most explanations.`
            : `You are a code assistant providing quick explanations.
Keep responses brief and focused - under 30 words when possible.`;

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
     * Execute strategic path (Gemini 1.5 Pro via Gemini or Vertex)
     */
    private async executeStrategicPath(
        _prompt: string,
        intent: ClassifiedIntent,
        context: SymbolContext | null,
        neighborCode: string[],
        analysisType: 'security' | 'refactor' | 'dependencies' | 'general'
    ): Promise<AIResponse> {
        // Prefer GeminiClient (API Key based) for easier setup
        const client = this.geminiClient || this.vertexClient;

        if (!client) {
            return {
                content: 'AI Strategic client not available. Please set GEMINI_API_KEY or GOOGLE_CLOUD_PROJECT.',
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
                if (fs.existsSync(context.symbol.filePath)) {
                    const content = fs.readFileSync(context.symbol.filePath, 'utf-8');
                    const lines = content.split('\n');
                    const start = Math.max(0, context.symbol.rangeStartLine - 1);
                    const end = Math.min(lines.length, context.symbol.rangeEndLine);
                    targetCode = lines.slice(start, end).join('\n');
                } else {
                    targetCode = '// File not found for target code';
                }
            } catch {
                targetCode = '// Could not read target code';
            }
        }

        // Execute analysis using the available client
        const response = await client.analyzeCode(
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


    /**
     * Get available MCP tools
     */


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
     * Optimized Domain Classification using the Architecture Skeleton (JSON 1)
     * Categorizes files into domains and generates high-level summaries.
     */


    /**
     * Architect Pass: Refine system graph using Gemini 1.5 Pro
     * Sends structural skeleton to AI to infer purpose, impact, and implicit links
     */


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
    /**
     * Semantic module labeling using Gemini
     * Generates human-friendly names for top-level folders based on contents and imports
     */

}

/**
 * Create an AI orchestrator instance
 */
export function createOrchestrator(db: CodeIndexDatabase): AIOrchestrator {
    return new AIOrchestrator(db);
}
