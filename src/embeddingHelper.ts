import OpenAI from 'openai';

let openai: OpenAI | null = null;

/**
 * Initializes the OpenAI client.
 * @param apiKey OpenAI API key
 */
export function initializeOpenAI(apiKey: string) {
    console.log('Initializing OpenAI client with key:', !!apiKey);  // Log 7
    if (!apiKey) {
        throw new Error('OpenAI API key is required');
    }
    
    openai = new OpenAI({
        apiKey: apiKey,
        dangerouslyAllowBrowser: true
    });
    console.log('OpenAI client initialized successfully');  // Log 8
}

/**
 * Generates an embedding for the given text using OpenAI's API.
 * @param text The input text to embed.
 * @param apiKey The OpenAI API key
 * @returns A promise that resolves to the embedding vector.
 */
export async function generateEmbedding(text: string, apiKey: string): Promise<number[]> {
    console.log('Generating embedding with key:', !!apiKey);  // Log 9
    if (!apiKey) {
        throw new Error('OpenAI API key is required');
    }

    // Reinitialize if API key changed or client not initialized
    if (!openai || openai.apiKey !== apiKey) {
        initializeOpenAI(apiKey);
    }

    try {
        const response = await openai!.embeddings.create({
            model: "text-embedding-ada-002",
            input: text.slice(0, 8000), // OpenAI has a token limit, roughly 8000 chars
        });

        return response.data[0].embedding;
    } catch (error: any) {
        if (error.status === 403) {
            throw new Error('Invalid OpenAI API key. Please check your settings.');
        } else if (error.status === 429) {
            throw new Error('OpenAI rate limit exceeded. Please try again later.');
        }
        console.error('Error generating embedding:', error);
        throw error;
    }
}