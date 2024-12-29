import { TFile, Vault, MetadataCache } from 'obsidian';
import { generateEmbedding } from '../embeddingHelper';
import { getAllEmbeddings } from '../storageService';

export interface SearchResult {
    id: string;
    score: number;
    content: string;
    explicit?: boolean;
    fullContent?: string;
    linkedContexts?: LinkedContext[];
    keywordScore?: number;
    linkScore?: number;
    matchedKeywords?: string[];
    linkPath?: string[];
}

export interface LinkedContext {
    notePath: string;
    relevance: number;
    context: string;
    linkDistance: number;
}

export class SearchService {
    constructor(
        private vault: Vault,
        private metadataCache: MetadataCache,
        private apiKey: string
    ) {}

    private async performSemanticSearch(query: string): Promise<SearchResult[]> {
        const queryEmbedding = await generateEmbedding(query, this.apiKey);
        const embeddings = await getAllEmbeddings();
        const results: SearchResult[] = [];
        const similarityThreshold = 0.75;

        for (const doc of embeddings) {
            const score = this.cosineSimilarity(queryEmbedding, doc.embedding);
            if (score >= similarityThreshold) {
                const file = this.vault.getAbstractFileByPath(doc.id);
                if (file instanceof TFile) {
                    try {
                        const content = await this.vault.read(file);
                        results.push({
                            id: doc.id,
                            score,
                            content: this.extractRelevantSection(content),
                            fullContent: content
                        });
                    } catch (error) {
                        console.error(`Error reading file ${doc.id}:`, error);
                    }
                }
            }
        }

        return results.sort((a, b) => b.score - a.score).slice(0, 5);
    }

    private extractKeywords(text: string): string[] {
        const words = text.toLowerCase()
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .split(/\s+/)
            .filter(word => word.length > 2);
        
        const stopWords = new Set([
            'the', 'is', 'at', 'which', 'on', 'a', 'an', 'and', 'or', 
            'but', 'in', 'to', 'for', 'with', 'by', 'from', 'up', 'about', 
            'into', 'over', 'after'
        ]);
        
        return words.filter(word => !stopWords.has(word));
    }

    private calculateKeywordScore(content: string, keywords: string[]): number {
        let score = 0;
        const contentLower = content.toLowerCase();
        
        for (const keyword of keywords) {
            const regex = new RegExp(`\\b${keyword}\\b`, 'gi');
            const matches = contentLower.match(regex);
            if (matches) {
                score += matches.length;
            }
        }

        return score / (content.length / 100);
    }

    private extractRelevantSection(content: string): string {
        return content.slice(0, 500);
    }

    private cosineSimilarity(vecA: number[], vecB: number[]): number {
        const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
        const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
        const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
        return dotProduct / (magnitudeA * magnitudeB);
    }

    public async search(query: string): Promise<SearchResult[]> {
        const semanticResults = await this.performSemanticSearch(query);
        const keywords = this.extractKeywords(query);
        
        // Add keyword scores to semantic results
        for (const result of semanticResults) {
            if (result.fullContent) {
                result.keywordScore = this.calculateKeywordScore(result.fullContent, keywords);
                result.matchedKeywords = keywords.filter(k => 
                    result.fullContent!.toLowerCase().includes(k.toLowerCase())
                );
            }
        }

        // Process linked notes
        const finalResults: SearchResult[] = [];
        for (const result of semanticResults) {
            const linkedContexts = await this.traverseLinks(result);
            if (linkedContexts.length > 0) {
                result.linkedContexts = linkedContexts;
            }
            finalResults.push(result);
        }

        return finalResults.sort((a, b) => b.score - a.score);
    }

    private async traverseLinks(result: SearchResult): Promise<LinkedContext[]> {
        const linkedContexts: LinkedContext[] = [];
        const processedFiles = new Set<string>();
        
        const file = this.vault.getAbstractFileByPath(result.id);
        if (!(file instanceof TFile)) return linkedContexts;

        const fileCache = this.metadataCache.getFileCache(file);
        if (!fileCache) return linkedContexts;

        // Process forward links
        const links = fileCache.links || [];
        for (const link of links) {
            const linkedFile = this.vault.getAbstractFileByPath(link.link);
            if (linkedFile instanceof TFile && !processedFiles.has(linkedFile.path)) {
                processedFiles.add(linkedFile.path);
                const context = await this.processLinkedFile(linkedFile, result.score);
                if (context) linkedContexts.push(context);
            }
        }

        // Process backlinks
        const allFiles = this.vault.getMarkdownFiles();
        for (const potentialSource of allFiles) {
            const sourceCache = this.metadataCache.getFileCache(potentialSource);
            if (sourceCache?.links) {
                const hasLink = sourceCache.links.some(link => 
                    link.link === file.path || 
                    link.link === file.basename
                );
                if (hasLink && !processedFiles.has(potentialSource.path)) {
                    processedFiles.add(potentialSource.path);
                    const context = await this.processLinkedFile(potentialSource, result.score);
                    if (context) linkedContexts.push(context);
                }
            }
        }

        return linkedContexts;
    }

    private async processLinkedFile(file: TFile, parentScore: number): Promise<LinkedContext | null> {
        try {
            const content = await this.vault.read(file);
            return {
                notePath: file.path,
                relevance: parentScore * 0.8,
                context: this.extractRelevantSection(content),
                linkDistance: 1
            };
        } catch (error) {
            console.error(`Error processing linked file ${file.path}:`, error);
            return null;
        }
    }
} 