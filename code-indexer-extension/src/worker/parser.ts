// Purpose: Tree-sitter parser initialization and management
// Handles WASM parser loading and AST generation
// Runs exclusively in worker thread

import Parser from 'web-tree-sitter';

export class TreeSitterParser {
    private parser: Parser | null = null;
    private languages: Map<string, Parser.Language> = new Map();
    private initialized: boolean = false;

    /**
     * Initialize tree-sitter WASM and load language grammars
     */
    async initialize(): Promise<void> {
        if (this.initialized) {
            return;
        }

        // Initialize tree-sitter WASM
        await Parser.init();
        this.parser = new Parser();

        // Load language grammars from node_modules
        try {
            // Load TypeScript WASM
            const typescriptWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-typescript.wasm');
            const typescript = await Parser.Language.load(typescriptWasmPath);
            this.languages.set('typescript', typescript);

            // Load Python WASM
            const pythonWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm');
            const python = await Parser.Language.load(pythonWasmPath);
            this.languages.set('python', python);

            // Load C WASM
            const cWasmPath = require.resolve('tree-sitter-wasms/out/tree-sitter-c.wasm');
            const c = await Parser.Language.load(cWasmPath);
            this.languages.set('c', c);

            this.initialized = true;
        } catch (error) {
            throw new Error(`Failed to load tree-sitter grammars: ${error}`);
        }
    }

    /**
     * Parse source code and return AST
     */
    parse(code: string, language: 'typescript' | 'python' | 'c'): Parser.Tree {
        if (!this.parser || !this.initialized) {
            throw new Error('Parser not initialized. Call initialize() first.');
        }

        const lang = this.languages.get(language);
        if (!lang) {
            throw new Error(`Language ${language} not loaded`);
        }

        this.parser.setLanguage(lang);
        const tree = this.parser.parse(code);

        if (!tree) {
            throw new Error(`Failed to parse code as ${language}`);
        }

        return tree;
    }

    /**
     * Check if parser is ready
     */
    isReady(): boolean {
        return this.initialized;
    }

    /**
     * Get supported languages
     */
    getSupportedLanguages(): string[] {
        return Array.from(this.languages.keys());
    }
}
