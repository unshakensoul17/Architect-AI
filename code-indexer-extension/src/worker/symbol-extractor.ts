// Purpose: Extract symbols and edges from AST nodes
// Flattens hierarchical AST into queryable database records
// Preserves semantic relationships while enabling efficient queries

import Parser from 'web-tree-sitter';
import { NewSymbol, NewEdge } from '../db/schema';

export interface ExtractionResult {
    symbols: NewSymbol[];
    edges: NewEdge[];
}

/**
 * Symbol Extractor
 * Traverses tree-sitter AST and extracts symbols and relationships
 */
export class SymbolExtractor {
    private symbols: NewSymbol[] = [];
    private edges: NewEdge[] = [];
    private symbolIdMap: Map<string, number> = new Map();
    private currentId: number = 0;
    private filePath: string = '';
    private language: string = '';

    /**
     * Extract symbols and edges from AST
     */
    extract(
        tree: Parser.Tree,
        filePath: string,
        language: 'typescript' | 'python' | 'c'
    ): ExtractionResult {
        this.symbols = [];
        this.edges = [];
        this.symbolIdMap.clear();
        this.currentId = 0;
        this.filePath = filePath;
        this.language = language;

        const rootNode = tree.rootNode;
        this.traverseNode(rootNode, null);

        return {
            symbols: this.symbols,
            edges: this.edges,
        };
    }

    /**
     * Recursively traverse AST nodes
     */
    private traverseNode(node: Parser.SyntaxNode, parentSymbolKey: string | null): void {
        // Extract symbol based on node type
        const symbolKey = this.extractSymbol(node, parentSymbolKey);

        // Recursively process children
        for (let i = 0; i < node.childCount; i++) {
            this.traverseNode(node.child(i)!, symbolKey || parentSymbolKey);
        }
    }

    /**
     * Extract symbol from node and create edges
     */
    private extractSymbol(
        node: Parser.SyntaxNode,
        parentSymbolKey: string | null
    ): string | null {
        const nodeType = node.type;
        let symbolType: string | null = null;
        let symbolName: string | null = null;

        // Language-specific symbol extraction
        if (this.language === 'typescript') {
            symbolType = this.extractTypeScriptSymbol(node);
            symbolName = this.getNodeName(node);
        } else if (this.language === 'python') {
            symbolType = this.extractPythonSymbol(node);
            symbolName = this.getNodeName(node);
        } else if (this.language === 'c') {
            symbolType = this.extractCSymbol(node);
            symbolName = this.getNodeName(node);
        }

        if (!symbolType || !symbolName) {
            // Also check for import/call relationships
            this.extractEdges(node, parentSymbolKey);
            return null;
        }

        // Calculate complexity
        const complexity = this.calculateComplexity(node);

        // Create symbol
        const symbol: NewSymbol = {
            name: symbolName,
            type: symbolType,
            filePath: this.filePath,
            rangeStartLine: node.startPosition.row + 1,
            rangeStartColumn: node.startPosition.column,
            rangeEndLine: node.endPosition.row + 1,
            rangeEndColumn: node.endPosition.column,
            complexity,
        };

        const symbolKey = `${this.filePath}:${symbolName}:${node.startPosition.row}`;
        this.symbols.push(symbol);
        this.symbolIdMap.set(symbolKey, this.currentId);
        this.currentId++;

        return symbolKey;
    }

    /**
     * Extract TypeScript-specific symbols
     */
    private extractTypeScriptSymbol(node: Parser.SyntaxNode): string | null {
        const typeMap: Record<string, string> = {
            function_declaration: 'function',
            method_definition: 'method',
            class_declaration: 'class',
            interface_declaration: 'interface',
            type_alias_declaration: 'type',
            variable_declaration: 'variable',
            lexical_declaration: 'variable',
            enum_declaration: 'enum',
            arrow_function: 'function',
            function_expression: 'function',
        };

        return typeMap[node.type] || null;
    }

    /**
     * Extract Python-specific symbols
     */
    private extractPythonSymbol(node: Parser.SyntaxNode): string | null {
        const typeMap: Record<string, string> = {
            function_definition: 'function',
            class_definition: 'class',
            decorated_definition: 'decorator',
        };

        return typeMap[node.type] || null;
    }

    /**
     * Extract C-specific symbols
     */
    private extractCSymbol(node: Parser.SyntaxNode): string | null {
        const typeMap: Record<string, string> = {
            function_definition: 'function',
            declaration: 'variable',
            struct_specifier: 'struct',
            enum_specifier: 'enum',
            union_specifier: 'union',
        };

        return typeMap[node.type] || null;
    }

    /**
     * Get symbol name from node
     */
    private getNodeName(node: Parser.SyntaxNode): string | null {
        // Try to find identifier child
        const identifierChild = node.children.find(
            (child) => child.type === 'identifier' ||
                child.type === 'property_identifier' ||
                child.type === 'type_identifier'
        );

        if (identifierChild) {
            return identifierChild.text;
        }

        // For some nodes, the name might be in a specific child
        if (node.type === 'variable_declaration' || node.type === 'lexical_declaration') {
            const declarator = node.children.find((child) => child.type === 'variable_declarator');
            if (declarator) {
                const id = declarator.children.find((child) => child.type === 'identifier');
                if (id) return id.text;
            }
        }

        // Handle export_statement explicitly if needed, but usually the declaration is a child
        return null;
    }

    /**
     * Extract edges (imports, calls, inheritance)
     */
    private extractEdges(node: Parser.SyntaxNode, parentSymbolKey: string | null): void {
        // Import statements
        if (
            node.type === 'import_statement' ||
            node.type === 'import_from_statement' ||
            node.type === 'import_clause'
        ) {
            // Track imports for future edge creation
            // This requires tracking imported symbols
        }

        // Function calls
        if (node.type === 'call_expression') {
            const functionName = node.children.find((child) => child.type === 'identifier');
            if (functionName && parentSymbolKey) {
                // Create call edge when we can resolve the target
            }
        }

        // Inheritance (extends/implements)
        if (node.type === 'class_heritage' || node.type === 'argument_list') {
            // Track inheritance relationships
        }
    }

    /**
     * Calculate cyclomatic complexity
     * Counts decision points + 1
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
            'binary_expression', // && and ||
        ];

        const traverse = (n: Parser.SyntaxNode) => {
            if (decisionNodes.includes(n.type)) {
                complexity++;
            }

            for (let i = 0; i < n.childCount; i++) {
                traverse(n.child(i)!);
            }
        };

        traverse(node);
        return complexity;
    }
}
