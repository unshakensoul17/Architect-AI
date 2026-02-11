// Purpose: Domain classification MCP tool
// Exposes domain classification capabilities to AI models
// Allows AI to classify symbols into architectural domains

import { DomainType } from '../../domain/classifier';

/**
 * Input for classify_domain tool
 */
export interface ClassifyDomainInput {
    symbolName: string;
    filePath: string;
    imports: string[];
    codeSnippet?: string;
}

/**
 * Result from classify_domain tool
 */
export interface ClassifyDomainResult {
    success: boolean;
    domain?: DomainType;
    confidence?: number;
    reasoning?: string;
    error?: string;
}

/**
 * Domain classification tool definition
 */
export const classifyDomainToolDefinition = {
    name: 'classify_domain',
    description: 'Classify a code symbol into an architectural domain (auth, payment, api, database, etc.). Analyzes symbol name, file path, imports, and optional code snippet to determine the most appropriate domain classification.',
    inputSchema: {
        type: 'object',
        properties: {
            symbolName: {
                type: 'string',
                description: 'The name of the symbol to classify (e.g., "loginUser", "processPayment")',
            },
            filePath: {
                type: 'string',
                description: 'The file path containing the symbol (e.g., "/src/auth/login.ts")',
            },
            imports: {
                type: 'array',
                items: { type: 'string' },
                description: 'Array of imported module names (e.g., ["jwt", "bcrypt", "passport"])',
            },
            codeSnippet: {
                type: 'string',
                description: 'Optional code snippet of the symbol for additional context',
            },
        },
        required: ['symbolName', 'filePath', 'imports'],
    },
};

/**
 * Available domain types for classification
 */
export const DOMAIN_TYPES = [
    'auth',
    'payment',
    'api',
    'database',
    'notification',
    'core',
    'ui',
    'util',
    'test',
    'config',
    'unknown',
] as const;

/**
 * Domain descriptions for AI context
 */
export const DOMAIN_DESCRIPTIONS: Record<DomainType, string> = {
    auth: 'Authentication, authorization, user sessions, security, permissions, OAuth, JWT tokens',
    payment: 'Payment processing, billing, transactions, subscriptions, invoices, Stripe, PayPal',
    api: 'REST APIs, GraphQL, external integrations, webhooks, API clients, HTTP requests',
    database: 'Database access, ORM, queries, migrations, models, SQL, PostgreSQL, MongoDB',
    notification: 'Email, SMS, push notifications, alerts, messaging services, templates',
    core: 'Core business logic, domain models, services, main application flow',
    ui: 'User interface, React components, views, pages, forms, styling',
    util: 'Utility functions, helpers, formatters, validators, common tools',
    test: 'Test files, test utilities, mocks, fixtures, testing helpers',
    config: 'Configuration, environment variables, settings, constants',
    unknown: 'Unclear or ambiguous domain classification',
};
