import { App, Modal, TextComponent, Notice } from 'obsidian';
import { SearchService } from '../services/SearchService';
import OpenAI from 'openai';

const AUTOCOMPLETE_OPTIONS = [
    "just continue",
    "write a counterargument",
    "expand on the current paragraph",
    "write a conclusion"
];

// Add this interface near the top of the file
interface WritingContext {
    fullContent: string;
    currentParagraph: string;
    precedingContent: string;
    followingContent: string;
}

export class ContinueWritingModal extends Modal {
    private input: TextComponent;
    private searchService: SearchService;
    private openai: OpenAI;
    private currentContent: string;
    private cursorPosition: number;

    constructor(
        app: App, 
        searchService: SearchService,
        openai: OpenAI,
        content: string,
        cursorPosition: number,
        onSubmit: (prompt: string) => void
    ) {
        super(app);
        this.searchService = searchService;
        this.openai = openai;
        this.currentContent = content;
        this.cursorPosition = cursorPosition;
        
        // Create input field
        this.input = new TextComponent(this.contentEl)
            .setPlaceholder("What do you want Sidekick to write next?");
        
        // Handle submit
        this.input.inputEl.addEventListener('keydown', async (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                onSubmit(this.input.getValue());
                this.close();
            }
        });

        // Add autocomplete options
        const suggestionsContainer = this.contentEl.createDiv('suggestions');
        AUTOCOMPLETE_OPTIONS.forEach(option => {
            const btn = suggestionsContainer.createEl('button', {
                text: option,
                cls: 'suggestion-button'
            });
            btn.addEventListener('click', () => {
                onSubmit(option);
                this.close();
            });
        });
    }

    onOpen() {
        super.onOpen();
        this.input.inputEl.focus();
    }
}

async function extractSearchQueries(openai: OpenAI, content: string): Promise<string[]> {
    const response = await openai.chat.completions.create({
        model: "gpt-4-0125-preview",  // Upgrade to GPT-4 for better analysis
        messages: [
            {
                role: "system",
                content: `Analyze this text and extract key concepts for semantic search. Your goal is to find connections to other notes.

Guidelines:
1. Look for:
   - Main concepts and ideas
   - Underlying themes
   - Related fields or domains
   - Specific technical terms
   - Abstract patterns that might appear in other contexts
2. Return 3-5 search queries
3. Each query should be 2-4 words
4. Include both specific and abstract concepts
5. Think laterally about potential connections

Return as a JSON array of strings.

Example:
For "I've been thinking about how social media affects our attention spans and ability to focus deeply on tasks"
Return: ["attention spans", "deep focus", "social media effects", "cognitive impact", "digital distraction"]`
            },
            {
                role: "user",
                content: content
            }
        ],
        temperature: 0.3,
    });

    try {
        return JSON.parse(response.choices[0].message?.content || "[]");
    } catch {
        return [content];
    }
}

// Add this helper function to get the current context around the cursor
function getCurrentWritingContext(content: string, cursorPosition: number): WritingContext {
    // Split into lines
    const lines = content.split('\n');
    let currentPosition = 0;
    let currentLineIndex = 0;
    
    // Find which line we're on
    for (let i = 0; i < lines.length; i++) {
        if (currentPosition + lines[i].length >= cursorPosition) {
            currentLineIndex = i;
            break;
        }
        currentPosition += lines[i].length + 1; // +1 for newline
    }
    
    // Get surrounding context (current paragraph)
    let startLine = currentLineIndex;
    let endLine = currentLineIndex;
    
    // Look backwards for paragraph start
    while (startLine > 0 && lines[startLine - 1].trim() !== '') {
        startLine--;
    }
    
    // Look forwards for paragraph end
    while (endLine < lines.length - 1 && lines[endLine + 1].trim() !== '') {
        endLine++;
    }
    
    return {
        fullContent: content,
        currentParagraph: lines.slice(startLine, endLine + 1).join('\n'),
        precedingContent: lines.slice(Math.max(0, startLine - 5), startLine).join('\n'),
        followingContent: lines.slice(endLine + 1, endLine + 6).join('\n')
    };
}

export async function handleContinueWriting(
    app: App,
    searchService: SearchService,
    openai: OpenAI,
    content: string,
    cursorPosition: number
): Promise<string | null> {
    return new Promise((resolve) => {
        const modal = new ContinueWritingModal(
            app,
            searchService,
            openai,
            content,
            cursorPosition,
            async (prompt) => {
                try {
                    // First, analyze the current writing context
                    const writingContext = getCurrentWritingContext(content, cursorPosition);
                    
                    // Extract search queries from both the full content and current paragraph
                    console.log('Extracting search queries...');
                    const [fullContentQueries, currentParaQueries] = await Promise.all([
                        extractSearchQueries(openai, content),
                        extractSearchQueries(openai, writingContext.currentParagraph)
                    ]);
                    
                    // Combine and deduplicate queries
                    const uniqueQueries = Array.from(new Set([...fullContentQueries, ...currentParaQueries]));
                    console.log('Generated queries:', uniqueQueries);

                    // Search for each query with different scopes
                    console.log('Searching for relevant context...');
                    const searchPromises = uniqueQueries.flatMap(query => [
                        searchService.search(query),  // Basic search
                        searchService.search(`${query} recent`),  // Recent context
                        searchService.search(`${query} connected`)  // Connected concepts
                    ]);

                    const allSearchResults = await Promise.all(searchPromises);

                    // Combine and deduplicate results, but preserve order of relevance
                    const seenPaths = new Set();
                    const context = allSearchResults
                        .flat()
                        .filter(result => {
                            if (seenPaths.has(result.id)) return false;
                            seenPaths.add(result.id);
                            return true;
                        })
                        .sort((a, b) => (b.score || 0) - (a.score || 0))  // Sort by relevance
                        .slice(0, 5)  // Take top 5 most relevant
                        .map(r => `From ${r.id}:\n${r.content}`)
                        .join('\n\n');

                    console.log('Found context from', seenPaths.size, 'notes');

                    // Generate continuation
                    console.log('Generating continuation...');

                    const response = await openai.chat.completions.create({
                        model: "gpt-4-0125-preview",  // Use GPT-4 for better synthesis
                        messages: [
                            {
                                role: "system",
                                content: `The user has asked you to continue writing their note. Use their their EXACT same style and voice. Remember, you are not having a conversation. 

Key guidelines:
1. Maintain the exact same perspective (first/second/third person). Never address the user - you ARE the user's voice. Never break character or acknowledge that you're an AI.
2. Match the user's tone, formality level, and writing style precisely. If the user is writing personally (e.g., "I think...", "My experience..."), continue in that same personal voice. If the user is writing academically/objectively, maintain that same objective tone.
3. Continue the flow of thought naturally. Do not repeat what was already written. Add something new to the writing. Expand on the ideas. Add something new, novel, and thought provoking.
4. Make sure you are concise. You should write no more than 4 sentences.`
                            },
                            {
                                role: "user",
                                content: `Here is a piece of writing. The +++ marker indicates where you should continue writing, maintaining the exact same perspective, style, and train of thought. In addition to the previous instructions, the user has sent the following prompt: ${prompt}. Please consider the user's wishes above all else.

Context before the current paragraph:
${writingContext.precedingContent}

Current paragraph (continue from here):
${writingContext.currentParagraph}+++

Context after the current paragraph:
${writingContext.followingContent}

Additional relevant context from other notes. Use this context to inform your writing. Draw in other ideas. Expand on what the user has said. Make connections to other notes. Keep the overall length to 4 sentences or less. Match the user's tone and perspective. Add something NEW and interesting and novel.
${context}`
                            }
                        ],
                        temperature: 0.7,
                    });

                    resolve(response.choices[0].message?.content || null);
                } catch (error) {
                    console.error('Error continuing writing:', error);
                    new Notice('Failed to continue writing');
                    resolve(null);
                }
            }
        );
        modal.open();
    });
} 