import { generateEmbedding } from './embeddingHelper';
import { getAllEmbeddings, Embedding } from './storageService';
import { Vault, TFile } from 'obsidian';

export interface SearchResult {
    id: string;
    score: number;
    content: string;
    explicit?: boolean;
    fullContent?: string;
    linkedContexts?: LinkedContext[];
}

export interface LinkedContext {
    notePath: string;
    relevance: number;
    context: string;
}

function cosineSimilarity(vecA: number[], vecB: number[]): number {
    const dotProduct = vecA.reduce((sum, a, i) => sum + a * vecB[i], 0);
    const magnitudeA = Math.sqrt(vecA.reduce((sum, a) => sum + a * a, 0));
    const magnitudeB = Math.sqrt(vecB.reduce((sum, b) => sum + b * b, 0));
    const similarity = dotProduct / (magnitudeA * magnitudeB);
    return Math.min(Math.max(similarity, -1), 1);
}

async function getLinkedNotes(content: string, vault: Vault): Promise<TFile[]> {
    const linkRegex = /\[\[(.*?)\]\]/g;
    const linkedFiles: TFile[] = [];
    const matches = [...content.matchAll(linkRegex)];
    
    for (const match of matches) {
        const path = match[1].split('|')[0]; // Handle aliased links
        const file = vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            linkedFiles.push(file);
        }
    }
    
    return linkedFiles;
}

async function getRelevantLinkedContext(
    queryEmbedding: number[],
    linkedFile: TFile,
    vault: Vault,
    apiKey: string,
    similarityThreshold: number = 0.75
): Promise<LinkedContext | null> {
    try {
        const content = await vault.read(linkedFile);
        const chunks = splitIntoChunks(content, 500);
        const chunkEmbeddings = await Promise.all(
            chunks.map(chunk => generateEmbedding(chunk, apiKey))
        );
        
        // Find the most relevant chunk
        const chunkScores = chunkEmbeddings.map(emb => cosineSimilarity(queryEmbedding, emb));
        const bestScore = Math.max(...chunkScores);
        
        if (bestScore >= similarityThreshold) {
            const bestChunkIndex = chunkScores.indexOf(bestScore);
            return {
                notePath: linkedFile.path,
                relevance: bestScore,
                context: chunks[bestChunkIndex]
            };
        }
    } catch (error) {
        console.error(`Error processing linked note ${linkedFile.path}:`, error);
    }
    
    return null;
}

export async function semanticSearch(
    query: string, 
    apiKey: string,
    vault: Vault,
    topK: number = 3,
    onProgress?: (noteName: string) => void
): Promise<SearchResult[]> {
    const queryEmbedding = await generateEmbedding(query, apiKey);
    const embeddings = await getAllEmbeddings();
    const results: SearchResult[] = [];
    const similarityThreshold = 0.80;
    
    for (const doc of embeddings) {
        if (onProgress) {
            onProgress(doc.id);
        }
        
        const score = cosineSimilarity(queryEmbedding, doc.embedding);
        
        if (score >= similarityThreshold) {
            const file = vault.getAbstractFileByPath(doc.id);
            
            if (file instanceof TFile) {
                try {
                    const content = await vault.read(file);
                    
                    // Process main content
                    const chunks = splitIntoChunks(content, 500);
                    const chunkEmbeddings = await Promise.all(
                        chunks.map(chunk => generateEmbedding(chunk, apiKey))
                    );
                    const chunkScores = chunkEmbeddings.map(emb => 
                        cosineSimilarity(queryEmbedding, emb)
                    );
                    const bestChunkIndex = chunkScores.indexOf(Math.max(...chunkScores));
                    
                    // Get linked notes
                    const linkedFiles = await getLinkedNotes(content, vault);
                    const linkedContexts: LinkedContext[] = [];
                    
                    // Process each linked note
                    for (const linkedFile of linkedFiles) {
                        const linkedContext = await getRelevantLinkedContext(
                            queryEmbedding,
                            linkedFile,
                            vault,
                            apiKey
                        );
                        
                        if (linkedContext) {
                            linkedContexts.push(linkedContext);
                        }
                    }
                    
                    // Sort linked contexts by relevance
                    linkedContexts.sort((a, b) => b.relevance - a.relevance);
                    
                    results.push({
                        id: doc.id,
                        score,
                        content: chunks[bestChunkIndex],
                        fullContent: content,
                        linkedContexts: linkedContexts.slice(0, 3) // Include top 3 most relevant linked contexts
                    });
                } catch (error) {
                    console.error(`Error reading file ${doc.id}:`, error);
                }
            }
        }
    }
    
    return results
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
}

function splitIntoChunks(text: string, chunkSize: number): string[] {
    const chunks: string[] = [];
    const sentences = text.split(/[.!?]+/);
    let currentChunk = '';
    
    for (const sentence of sentences) {
        if ((currentChunk + sentence).length > chunkSize) {
            if (currentChunk) chunks.push(currentChunk.trim());
            currentChunk = sentence;
        } else {
            currentChunk += (currentChunk ? ' ' : '') + sentence;
        }
    }
    
    if (currentChunk) chunks.push(currentChunk.trim());
    return chunks;
} 