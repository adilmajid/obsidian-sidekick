import localforage from 'localforage';

export interface Embedding {
    id: string;
    embedding: number[];
    lastModified?: number;
}

// Create a dedicated store for embeddings
const embeddingStore = localforage.createInstance({
    name: 'ObsidianChatSidebar',
    storeName: 'embeddings',
    description: 'Store for note embeddings'
});

export async function saveEmbedding(embedding: Embedding): Promise<void> {
    await embeddingStore.setItem(embedding.id, embedding);
}

export async function getEmbedding(id: string): Promise<Embedding | null> {
    return await embeddingStore.getItem<Embedding>(id);
}

export async function getAllEmbeddings(): Promise<Embedding[]> {
    const keys = await embeddingStore.keys();
    const embeddings: Embedding[] = [];
    for (const key of keys) {
        const emb = await embeddingStore.getItem<Embedding>(key);
        if (emb) {
            embeddings.push(emb);
        }
    }
    return embeddings;
}

export async function deleteEmbedding(id: string): Promise<void> {
    await embeddingStore.removeItem(id);
}