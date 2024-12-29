export type ChatRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
    role: ChatRole;
    content: string;
}

export interface ChatThread {
    id: string;
    messages: ChatMessage[];
    createdAt: number;
    lastModified: number;
    title?: string;
}

export interface ThreadStorage {
    version: number;
    threads: ChatThread[];
} 