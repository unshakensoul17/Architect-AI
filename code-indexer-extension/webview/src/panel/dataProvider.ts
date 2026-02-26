/**
 * Inspector Panel Data Provider
 *
 * Centralized data fetching layer with:
 * - Request/response correlation via requestId
 * - Timeout handling
 * - Request cancellation
 * - Response caching
 *
 * NO database logic - all queries go through extension → worker
 */

import type { VSCodeAPI } from '../types';
import type { NodeType, OverviewData, DependencyData, RiskData, AIResult } from '../types/inspector';

interface PendingRequest<T> {
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
    requestType: string;
}

interface CacheEntry<T> {
    data: T;
    timestamp: number;
}

class InspectorDataProvider {
    private vscode: VSCodeAPI;
    private pendingRequests = new Map<string, PendingRequest<unknown>>();
    private cache = new Map<string, CacheEntry<unknown>>();
    private readonly cacheTTL = 30000; // 30 seconds
    private readonly defaultTimeout = 10000; // 10 seconds
    private messageHandlerBound = false;

    constructor(vscode: VSCodeAPI) {
        this.vscode = vscode;
        this.setupMessageHandler();
    }

    private setupMessageHandler(): void {
        if (this.messageHandlerBound) return;
        this.messageHandlerBound = true;

        window.addEventListener('message', (event) => {
            const message = event.data;

            // Only handle messages with requestId that we're tracking
            if (!message.requestId) return;

            const pending = this.pendingRequests.get(message.requestId);
            if (!pending) return;

            // Clear timeout and remove from pending
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(message.requestId);

            // Resolve or reject based on response
            if (message.error) {
                pending.reject(new Error(message.error));
            } else {
                pending.resolve(message.data);
            }
        });
    }

    private generateRequestId(): string {
        return `inspector-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    }

    private getCacheKey(type: string, id: string): string {
        return `${type}:${id}`;
    }

    private getFromCache<T>(key: string): T | null {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data as T;
        }
        // Clean up expired entry
        if (cached) {
            this.cache.delete(key);
        }
        return null;
    }

    private setCache<T>(key: string, data: T): void {
        this.cache.set(key, { data, timestamp: Date.now() });
    }

    /**
     * Send request to extension and wait for response
     */
    private request<T>(
        type: string,
        payload: Record<string, unknown>,
        timeoutMs = this.defaultTimeout
    ): Promise<T> {
        const requestId = this.generateRequestId();

        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Request timeout: ${type}`));
            }, timeoutMs);

            this.pendingRequests.set(requestId, {
                resolve: resolve as (value: unknown) => void,
                reject,
                timeout,
                requestType: type,
            });

            this.vscode.postMessage({
                type,
                requestId,
                ...payload,
            });
        });
    }

    /**
     * Get overview data for a node
     */
    async getOverview(id: string, nodeType: NodeType): Promise<OverviewData> {
        const cacheKey = this.getCacheKey('overview', id);
        const cached = this.getFromCache<OverviewData>(cacheKey);
        if (cached) return cached;

        const data = await this.request<OverviewData>('inspector-overview', {
            nodeId: id,
            nodeType,
        });

        this.setCache(cacheKey, data);
        return data;
    }

    /**
     * Get dependencies for a node
     */
    async getDependencies(id: string, nodeType: NodeType): Promise<DependencyData> {
        const cacheKey = this.getCacheKey('deps', id);
        const cached = this.getFromCache<DependencyData>(cacheKey);
        if (cached) return cached;

        const data = await this.request<DependencyData>('inspector-dependencies', {
            nodeId: id,
            nodeType,
        });

        this.setCache(cacheKey, data);
        return data;
    }

    /**
     * Get risk data for a node
     */
    async getRisks(id: string, nodeType: NodeType): Promise<RiskData> {
        const cacheKey = this.getCacheKey('risks', id);
        const cached = this.getFromCache<RiskData>(cacheKey);
        if (cached) return cached;

        const data = await this.request<RiskData>('inspector-risks', {
            nodeId: id,
            nodeType,
        });

        this.setCache(cacheKey, data);
        return data;
    }

    /**
     * Execute an AI action (explain, audit, refactor, etc.)
     * Longer timeout since AI can take a while
     */
    async executeAIAction(
        id: string,
        action: 'explain' | 'audit' | 'refactor' | 'optimize'
    ): Promise<AIResult> {
        // Check cache for AI results too
        const cacheKey = this.getCacheKey(`ai-${action}`, id);
        const cached = this.getFromCache<AIResult>(cacheKey);
        if (cached) {
            return { ...cached, cached: true };
        }

        const result = await this.request<AIResult>(
            'inspector-ai-action',
            { nodeId: id, action },
            200000 // 200s — Gemini can take 120-173s for complex symbols
        );

        this.setCache(cacheKey, result);
        return result;
    }

    /**
     * Ask AI to explain a specific risk metric
     */
    async explainRisk(id: string, metric: string): Promise<string> {
        return this.request<string>('inspector-ai-why', { nodeId: id, metric }, 15000);
    }

    /**
     * Cancel only data-fetch requests (overview / deps / risks).
     * AI action requests are intentionally LEFT running — they are expensive
     * and the user expects a result even if they click elsewhere on the graph.
     */
    cancelDataRequests(): void {
        const AI_TYPES = new Set(['inspector-ai-action', 'inspector-ai-why']);
        for (const [requestId, pending] of this.pendingRequests) {
            if (!AI_TYPES.has(pending.requestType)) {
                clearTimeout(pending.timeout);
                pending.reject(new Error('Request cancelled'));
                this.pendingRequests.delete(requestId);
            }
        }
    }

    /**
     * Cancel ALL pending requests (use only on panel teardown / hard reset)
     */
    cancelPendingRequests(): void {
        for (const [, pending] of this.pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Request cancelled'));
        }
        this.pendingRequests.clear();
    }

    /**
     * Clear the cache
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Get pending request count (for debugging)
     */
    getPendingCount(): number {
        return this.pendingRequests.size;
    }
}

// Singleton instance
let providerInstance: InspectorDataProvider | null = null;

/**
 * Get the singleton data provider instance
 */
export function getDataProvider(vscode: VSCodeAPI): InspectorDataProvider {
    if (!providerInstance) {
        providerInstance = new InspectorDataProvider(vscode);
    }
    return providerInstance;
}

/**
 * Reset the provider (useful for testing)
 */
export function resetDataProvider(): void {
    if (providerInstance) {
        providerInstance.cancelPendingRequests();
        providerInstance.clearCache();
    }
    providerInstance = null;
}
