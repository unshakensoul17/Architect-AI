// Purpose: Extract symbols and edges from AST nodes
// Implements visitor pattern for comprehensive code graph construction
// Handles FunctionDeclaration, ClassDeclaration, ImportDeclaration, CallExpression

import Parser from 'web-tree-sitter';
import { NewSymbol, NewEdge } from '../db/schema';

export interface ExtractionResult {
    symbols: NewSymbol[];
    edges: NewEdge[];
    imports: ImportInfo[];
    calls: CallInfo[];
}

export interface ImportInfo {
    importedName: string;
    localName: string;
    sourceModule: string;
    filePath: string;
    line: number;
}

export interface CallInfo {
    callerSymbolKey: string;
    calleeName: string;
    filePath: string;
    line: number;
}

/**
 * Symbol Extractor
 * Traverses tree-sitter AST and extracts symbols, edges, imports, and calls
 */
export class SymbolExtractor {
    private symbols: NewSymbol[] = [];
    private edges: NewEdge[] = [];
    private symbolIdMap: Map<string, number> = new Map();
    private currentId: number = 0;
    private filePath: string = '';
    private language: string = '';

    // Import tracking
    private imports: ImportInfo[] = [];

    // Call expression tracking
    private calls: CallInfo[] = [];

    // Current context for call expression resolution
    private currentSymbolKey: string | null = null;

    /**
     * Extract symbols and edges from AST
     */
    extract(
        tree: Parser.Tree,
        filePath: string,
        language: 'typescript' | 'python' | 'c'
    ): ExtractionResult {
        // Reset state
        this.symbols = [];
        this.edges = [];
        this.symbolIdMap.clear();
        this.currentId = 0;
        this.filePath = filePath;
        this.language = language;
        this.imports = [];
        this.calls = [];
        this.currentSymbolKey = null;

        const rootNode = tree.rootNode;
        this.visitNode(rootNode, null);

        return {
            symbols: this.symbols,
            edges: this.edges,
            imports: this.imports,
            calls: this.calls,
        };
    }

    /**
     * Get symbol ID map for cross-file edge resolution
     */
    getSymbolIdMap(): Map<string, number> {
        return new Map(this.symbolIdMap);
    }

    /**
     * Create edges from call expressions to resolved symbols
     * Called after all files have been parsed
     */
    createCallEdges(
        calls: CallInfo[],
        globalSymbolMap: Map<string, number>
    ): NewEdge[] {
        const edges: NewEdge[] = [];

        for (const call of calls) {
            const sourceId = globalSymbolMap.get(call.callerSymbolKey);

            // Try to find target by function name
            for (const [key, id] of globalSymbolMap) {
                const symbolName = key.split(':')[1];
                if (symbolName === call.calleeName && sourceId !== undefined) {
                    edges.push({
                        sourceId,
                        targetId: id,
                        type: 'call',
                    });
                    break;
                }
            }
        }

        return edges;
    }

    /**
     * Create edges from imports to target symbols
     */
    createImportEdges(
        imports: ImportInfo[],
        globalSymbolMap: Map<string, number>
    ): NewEdge[] {
        const edges: NewEdge[] = [];

        for (const imp of imports) {
            // Find symbol in the source module
            for (const [key, id] of globalSymbolMap) {
                const [keyPath, symbolName] = key.split(':');

                // Check if this symbol matches the imported name and is from the source module
                if (symbolName === imp.importedName) {
                    // Try to match the source module path
                    const normalizedSource = imp.sourceModule.replace(/^\.\//, '').replace(/\.(ts|tsx|js|jsx)$/, '');
                    const normalizedPath = keyPath.replace(/\.(ts|tsx|js|jsx)$/, '');

                    if (normalizedPath.endsWith(normalizedSource)) {
                        // Find the symbol that did the import (file-level pseudo symbol or first function)
                        const importerKey = `${imp.filePath}:${imp.localName}:${imp.line}`;
                        const importerId = globalSymbolMap.get(importerKey);

                        if (importerId !== undefined) {
                            edges.push({
                                sourceId: importerId,
                                targetId: id,
                                type: 'import',
                            });
                        }
                        break;
                    }
                }
            }
        }

        return edges;
    }

    /**
     * Visitor pattern: traverse AST node
     */
    private visitNode(node: Parser.SyntaxNode, parentSymbolKey: string | null): void {
        // First, handle symbol extraction for this node
        const symbolKey = this.extractSymbolFromNode(node, parentSymbolKey);

        // Extract import declarations
        this.extractImports(node);

        // Extract call expressions
        this.extractCallExpression(node, symbolKey || parentSymbolKey);

        // Update current context for nested processing
        const contextKey = symbolKey || parentSymbolKey;

        // Recursively process all children
        for (let i = 0; i < node.childCount; i++) {
            const child = node.child(i);
            if (child) {
                this.visitNode(child, contextKey);
            }
        }
    }

    /**
     * Extract symbol from current node if it's a declaration
     */
    private extractSymbolFromNode(
        node: Parser.SyntaxNode,
        parentSymbolKey: string | null
    ): string | null {
        const symbolInfo = this.getSymbolInfo(node);

        if (!symbolInfo) {
            return null;
        }

        const { type, name } = symbolInfo;

        // Calculate complexity
        const complexity = this.calculateComplexity(node);

        // Create symbol
        const symbol: NewSymbol = {
            name,
            type,
            filePath: this.filePath,
            rangeStartLine: node.startPosition.row + 1,
            rangeStartColumn: node.startPosition.column,
            rangeEndLine: node.endPosition.row + 1,
            rangeEndColumn: node.endPosition.column,
            complexity,
        };

        const symbolKey = `${this.filePath}:${name}:${node.startPosition.row}`;
        this.symbols.push(symbol);
        this.symbolIdMap.set(symbolKey, this.currentId);
        this.currentId++;

        return symbolKey;
    }

    /**
     * Get symbol info based on node type and language
     */
    private getSymbolInfo(node: Parser.SyntaxNode): { type: string; name: string } | null {
        if (this.language === 'typescript') {
            return this.getTypeScriptSymbolInfo(node);
        } else if (this.language === 'python') {
            return this.getPythonSymbolInfo(node);
        } else if (this.language === 'c') {
            return this.getCSymbolInfo(node);
        }
        return null;
    }

    /**
     * Extract TypeScript symbol info
     */
    private getTypeScriptSymbolInfo(node: Parser.SyntaxNode): { type: string; name: string } | null {
        const typeMap: Record<string, string> = {
            function_declaration: 'function',
            method_definition: 'method',
            class_declaration: 'class',
            interface_declaration: 'interface',
            type_alias_declaration: 'type',
            enum_declaration: 'enum',
        };

        const type = typeMap[node.type];
        if (!type) {
            // Handle arrow functions and variable declarations specially
            if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
                return this.extractVariableDeclaration(node);
            }
            return null;
        }

        const name = this.getIdentifierName(node);
        if (!name) return null;

        return { type, name };
    }

    /**
     * Handle variable/const declarations (may contain arrow functions)
     */
    private extractVariableDeclaration(node: Parser.SyntaxNode): { type: string; name: string } | null {
        const declarator = node.children.find(c => c.type === 'variable_declarator');
        if (!declarator) return null;

        const identifier = declarator.children.find(c => c.type === 'identifier');
        if (!identifier) return null;

        // Check if the value is an arrow function
        const value = declarator.children.find(c =>
            c.type === 'arrow_function' || c.type === 'function_expression'
        );

        if (value) {
            return { type: 'function', name: identifier.text };
        }

        return { type: 'variable', name: identifier.text };
    }

    /**
     * Extract Python symbol info
     */
    private getPythonSymbolInfo(node: Parser.SyntaxNode): { type: string; name: string } | null {
        const typeMap: Record<string, string> = {
            function_definition: 'function',
            class_definition: 'class',
        };

        const type = typeMap[node.type];
        if (!type) return null;

        const name = this.getIdentifierName(node);
        if (!name) return null;

        return { type, name };
    }

    /**
     * Extract C symbol info
     */
    private getCSymbolInfo(node: Parser.SyntaxNode): { type: string; name: string } | null {
        const typeMap: Record<string, string> = {
            function_definition: 'function',
            struct_specifier: 'struct',
            enum_specifier: 'enum',
            union_specifier: 'union',
        };

        const type = typeMap[node.type];
        if (!type) return null;

        const name = this.getIdentifierName(node);
        if (!name) return null;

        return { type, name };
    }

    /**
     * Get identifier name from node
     */
    private getIdentifierName(node: Parser.SyntaxNode): string | null {
        for (const child of node.children) {
            if (
                child.type === 'identifier' ||
                child.type === 'type_identifier' ||
                child.type === 'property_identifier'
            ) {
                return child.text;
            }
        }
        return null;
    }

    /**
     * Extract import declarations
     */
    private extractImports(node: Parser.SyntaxNode): void {
        if (this.language === 'typescript') {
            this.extractTypeScriptImports(node);
        } else if (this.language === 'python') {
            this.extractPythonImports(node);
        }
        // C uses #include which is handled differently (preprocessor)
    }

    /**
     * Extract TypeScript imports
     */
    private extractTypeScriptImports(node: Parser.SyntaxNode): void {
        if (node.type !== 'import_statement') return;

        // Get the source module
        const sourceNode = node.children.find(c => c.type === 'string');
        if (!sourceNode) return;

        const sourceModule = sourceNode.text.replace(/['"]/g, '');

        // Find import clause
        const importClause = node.children.find(c => c.type === 'import_clause');
        if (!importClause) return;

        // Handle named imports: import { x, y } from 'module'
        const namedImports = importClause.children.find(c => c.type === 'named_imports');
        if (namedImports) {
            for (const child of namedImports.children) {
                if (child.type === 'import_specifier') {
                    const nameNode = child.children.find(c => c.type === 'identifier');
                    if (nameNode) {
                        const importedName = nameNode.text;
                        // Check for 'as' alias
                        const aliasNode = child.children.find((c, i, arr) =>
                            c.type === 'identifier' && i > 0
                        );
                        const localName = aliasNode ? aliasNode.text : importedName;

                        this.imports.push({
                            importedName,
                            localName,
                            sourceModule,
                            filePath: this.filePath,
                            line: node.startPosition.row + 1,
                        });
                    }
                }
            }
        }

        // Handle namespace imports: import * as ns from 'module'
        const namespaceImport = importClause.children.find(c => c.type === 'namespace_import');
        if (namespaceImport) {
            const identifier = namespaceImport.children.find(c => c.type === 'identifier');
            if (identifier) {
                this.imports.push({
                    importedName: '*',
                    localName: identifier.text,
                    sourceModule,
                    filePath: this.filePath,
                    line: node.startPosition.row + 1,
                });
            }
        }

        // Handle default imports: import x from 'module'
        const defaultImport = importClause.children.find(c => c.type === 'identifier');
        if (defaultImport) {
            this.imports.push({
                importedName: 'default',
                localName: defaultImport.text,
                sourceModule,
                filePath: this.filePath,
                line: node.startPosition.row + 1,
            });
        }
    }

    /**
     * Extract Python imports
     */
    private extractPythonImports(node: Parser.SyntaxNode): void {
        if (node.type === 'import_statement') {
            // import module
            const nameNode = node.children.find(c => c.type === 'dotted_name');
            if (nameNode) {
                this.imports.push({
                    importedName: nameNode.text,
                    localName: nameNode.text,
                    sourceModule: nameNode.text,
                    filePath: this.filePath,
                    line: node.startPosition.row + 1,
                });
            }
        } else if (node.type === 'import_from_statement') {
            // from module import x, y
            const moduleNode = node.children.find(c => c.type === 'dotted_name');
            const sourceModule = moduleNode?.text || '';

            for (const child of node.children) {
                if (child.type === 'dotted_name' && child !== moduleNode) {
                    this.imports.push({
                        importedName: child.text,
                        localName: child.text,
                        sourceModule,
                        filePath: this.filePath,
                        line: node.startPosition.row + 1,
                    });
                }
            }
        }
    }

    /**
     * Extract call expressions
     */
    private extractCallExpression(node: Parser.SyntaxNode, parentSymbolKey: string | null): void {
        if (node.type !== 'call_expression') return;
        if (!parentSymbolKey) return;

        // Get the called function name
        const calleeName = this.getCalleeName(node);
        if (!calleeName) return;

        this.calls.push({
            callerSymbolKey: parentSymbolKey,
            calleeName,
            filePath: this.filePath,
            line: node.startPosition.row + 1,
        });
    }

    /**
     * Get callee name from call expression
     */
    private getCalleeName(node: Parser.SyntaxNode): string | null {
        // Direct function call: foo()
        const identifierChild = node.children.find(c => c.type === 'identifier');
        if (identifierChild) {
            return identifierChild.text;
        }

        // Method call: obj.method()
        const memberExpression = node.children.find(c => c.type === 'member_expression');
        if (memberExpression) {
            const property = memberExpression.children.find(c =>
                c.type === 'property_identifier'
            );
            if (property) {
                return property.text;
            }
        }

        return null;
    }

    /**
     * Calculate cyclomatic complexity
     */
    private calculateComplexity(node: Parser.SyntaxNode): number {
        let complexity = 1;

        const decisionNodes = [
            'if_statement',
            'while_statement',
            'for_statement',
            'for_in_statement',
            'case',
            'catch_clause',
            'ternary_expression',
            'conditional_expression',
        ];

        const traverse = (n: Parser.SyntaxNode) => {
            if (decisionNodes.includes(n.type)) {
                complexity++;
            }

            // Count logical operators in binary expressions
            if (n.type === 'binary_expression') {
                const operator = n.children.find(c => c.type === '&&' || c.type === '||');
                if (operator) {
                    complexity++;
                }
            }

            for (let i = 0; i < n.childCount; i++) {
                const child = n.child(i);
                if (child) {
                    traverse(child);
                }
            }
        };

        traverse(node);
        return complexity;
    }
}
