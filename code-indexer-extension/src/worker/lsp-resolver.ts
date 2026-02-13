// Purpose: LSP-based symbol resolver for 100% accurate type definitions
// Uses VS Code's built-in Language Server Protocol to resolve symbol references
// Optional feature — enabled via architectAI.useLSP configuration
// NOTE: This runs in the extension host (not worker), since it needs VS Code API

import * as vscode from 'vscode';

/**
 * Result of an LSP definition lookup
 */
export interface LSPDefinition {
    filePath: string;
    line: number;
    column: number;
    symbolName: string;
}

/**
 * Unresolved call edge that needs LSP resolution
 */
export interface UnresolvedCall {
    callerFilePath: string;
    callerLine: number;
    callerColumn: number;
    calleeName: string;
    callerSymbolKey: string;
}

/**
 * Resolved edge from LSP
 */
export interface ResolvedEdge {
    callerSymbolKey: string;
    targetFilePath: string;
    targetLine: number;
    targetName: string;
}

/**
 * LSP Resolver
 * Uses VS Code's executeDefinitionProvider to get 100% accurate definitions
 * for TypeScript/JavaScript symbols that Tree-sitter (syntax-only) cannot compute.
 * 
 * Usage:
 *   const resolver = new LSPResolver();
 *   if (resolver.isEnabled()) {
 *       const resolved = await resolver.resolveDefinitions(unresolvedCalls);
 *   }
 */
export class LSPResolver {
    /**
     * Check if LSP resolution is enabled via settings
     */
    isEnabled(): boolean {
        const config = vscode.workspace.getConfiguration('architectAI');
        return config.get<boolean>('useLSP', false);
    }

    /**
     * Resolve a batch of unresolved calls using LSP
     * Groups by file to minimize document opens
     */
    async resolveDefinitions(calls: UnresolvedCall[]): Promise<ResolvedEdge[]> {
        const resolved: ResolvedEdge[] = [];

        // Group calls by file for efficiency
        const byFile = new Map<string, UnresolvedCall[]>();
        for (const call of calls) {
            const existing = byFile.get(call.callerFilePath) || [];
            existing.push(call);
            byFile.set(call.callerFilePath, existing);
        }

        for (const [filePath, fileCalls] of byFile) {
            try {
                const uri = vscode.Uri.file(filePath);

                for (const call of fileCalls) {
                    try {
                        const position = new vscode.Position(
                            call.callerLine - 1, // VS Code is 0-indexed
                            call.callerColumn
                        );

                        // Execute the built-in definition provider
                        const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                            'vscode.executeDefinitionProvider',
                            uri,
                            position
                        );

                        if (definitions && definitions.length > 0) {
                            const def = definitions[0];
                            resolved.push({
                                callerSymbolKey: call.callerSymbolKey,
                                targetFilePath: def.uri.fsPath,
                                targetLine: def.range.start.line + 1, // Back to 1-indexed
                                targetName: call.calleeName,
                            });
                        }
                    } catch (e) {
                        // Individual resolution failure — skip silently
                        console.warn(`[LSP] Failed to resolve ${call.calleeName} at ${filePath}:${call.callerLine}`, e);
                    }
                }
            } catch (e) {
                console.warn(`[LSP] Failed to process file: ${filePath}`, e);
            }
        }

        console.log(`[LSP] Resolved ${resolved.length}/${calls.length} definitions`);
        return resolved;
    }

    /**
     * Resolve a single symbol at a position
     */
    async resolveAtPosition(
        filePath: string,
        line: number,
        column: number
    ): Promise<LSPDefinition | null> {
        try {
            const uri = vscode.Uri.file(filePath);
            const position = new vscode.Position(line - 1, column);

            const definitions = await vscode.commands.executeCommand<vscode.Location[]>(
                'vscode.executeDefinitionProvider',
                uri,
                position
            );

            if (definitions && definitions.length > 0) {
                const def = definitions[0];
                // Read the document to get the symbol name at the definition
                const doc = await vscode.workspace.openTextDocument(def.uri);
                const wordRange = doc.getWordRangeAtPosition(def.range.start);
                const symbolName = wordRange ? doc.getText(wordRange) : '<unknown>';

                return {
                    filePath: def.uri.fsPath,
                    line: def.range.start.line + 1,
                    column: def.range.start.character,
                    symbolName,
                };
            }
        } catch (e) {
            console.warn(`[LSP] Resolution failed at ${filePath}:${line}:${column}`, e);
        }

        return null;
    }
}
