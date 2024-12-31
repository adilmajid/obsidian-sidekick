import localforage from 'localforage';

export interface Embedding {
    id: string;
    embedding: number[];
    lastModified?: number;
}

// Initialize localforage
localforage.config({
    name: 'ObsidianChatSidebar',
    storeName: 'embeddings',
});

export async function saveEmbedding(embedding: Embedding): Promise<void> {
    await localforage.setItem(embedding.id, embedding);
}

export async function getEmbedding(id: string): Promise<Embedding | null> {
    return await localforage.getItem<Embedding>(id);
}

export async function getAllEmbeddings(): Promise<Embedding[]> {
    const keys = await localforage.keys();
    const embeddings: Embedding[] = [];
    for (const key of keys) {
        const emb = await localforage.getItem<Embedding>(key);
        if (emb) {
            embeddings.push(emb);
        }
    }
    return embeddings;
}

export async function deleteEmbedding(id: string): Promise<void> {
    await localforage.removeItem(id);
}