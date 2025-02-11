import { ItemView, WorkspaceLeaf, Notice, TFile, SuggestModal, App, MarkdownRenderer, MarkdownView, Editor } from 'obsidian';
import OpenAI from 'openai';
import ObsidianChatSidebar from './main';
import { ChatCompletionMessageParam } from 'openai/resources/chat';
import { SearchService, SearchResult, LinkedContext } from './services/SearchService';
import { AVAILABLE_MODELS } from './settings';
import { ChatMessage, ChatThread } from './types';
import { ThreadHistoryDropdown } from './ThreadHistoryDropdown';
import './events';
import { DateService } from './services/DateService';

export const VIEW_TYPE_CHAT_SIDEBAR = 'chat-sidebar-view';

class NoteLinkSuggestModal extends SuggestModal<TFile> {
    private textInput: HTMLTextAreaElement;
    private chooseCallback: (file: TFile) => void;

    constructor(app: App, textInput: HTMLTextAreaElement, onChoose: (file: TFile) => void) {
        super(app);
        this.textInput = textInput;
        this.chooseCallback = onChoose;
    }

    getSuggestions(query: string): TFile[] {
        const files = this.app.vault.getMarkdownFiles();
        return files.filter(file => 
            file.path.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createEl("div", { text: file.path });
    }

    onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
        this.chooseCallback(file);
    }
}

export class ChatSidebarView extends ItemView {
    plugin: ObsidianChatSidebar;
    private openai: OpenAI | null = null;
    private chatHistory: ChatMessage[] = [];
    private inputField: HTMLTextAreaElement;
    private chatDisplay: HTMLElement;
    private currentRequest: AbortController | null = null;
    private resetMessage: HTMLElement | null = null;
    private searchService: SearchService;
    private modelSelector: HTMLSelectElement;
    private threads: ChatThread[] = [];
    private currentThreadId: string;
    private lastKnownCursorPosition: { 
        file: TFile;
        position: { line: number; ch: number; }
    } | null = null;

    constructor(leaf: WorkspaceLeaf, plugin: ObsidianChatSidebar) {
        super(leaf);
        this.plugin = plugin;
        this.searchService = new SearchService(
            this.app.vault,
            this.app.metadataCache,
            plugin.settings.openAIApiKey
        );
        this.currentThreadId = this.createNewThread();
    }

    getViewType(): string {
        return VIEW_TYPE_CHAT_SIDEBAR;
    }

    getDisplayText(): string {
        return 'Sidekick';
    }

    getIcon(): string {
        return "messages-square";
    }

    // Add this helper method to convert markdown links to Obsidian internal links
    private formatLinks(content: string): string {
        return content.replace(/\[\[([^\]]+)\]\]/g, (match, notePath) => {
            return `<a class="internal-link" data-path="${notePath}" href="#">${notePath}</a>`;
        });
    }

    // Add this method to handle link clicks
    private setupLinkHandler(element: HTMLElement) {
        element.addEventListener('click', async (event: MouseEvent) => {
            const target = event.target as HTMLElement;
            if (target.hasClass('internal-link')) {
                event.preventDefault();
                const path = target.getAttribute('data-path');
                if (path) {
                    const abstractFile = this.app.vault.getAbstractFileByPath(path);
                    if (abstractFile instanceof TFile) {
                        // Create a new tab without splitting
                        const newLeaf = this.app.workspace.getLeaf('tab');
                        await newLeaf.openFile(abstractFile, { active: true });
                    }
                }
            }
        });
    }

    async onOpen() {
        await this.loadThreads();
        
        this.containerEl.empty();
        this.containerEl.addClass('chat-sidebar-container');

        // Create the chat display area first
        this.chatDisplay = this.containerEl.createEl('div', { cls: 'chat-display' });

        // Add buttons container with both buttons
        const buttonContainer = this.chatDisplay.createDiv({ cls: 'chat-buttons-container' });
        const threadSelector = this.createThreadHistoryButton();
        const resetButton = this.createResetButton();
        buttonContainer.appendChild(threadSelector);
        buttonContainer.appendChild(resetButton);

        // After creating chatDisplay, render the previous messages from the current thread
        const currentThread = this.getCurrentThread();
        if (currentThread && currentThread.messages.length > 0) {
            // Sort messages by timestamp if available, otherwise assume they're in chronological order
            const messages = [...currentThread.messages]; // Create a copy of the array
            
            for (const message of messages) {
                const messageEl = this.chatDisplay.createDiv({
                    cls: `chat-message ${message.role}-message`
                });
                
                // Format and render the message content
                const formattedContent = this.formatLinks(message.content);
                await MarkdownRenderer.renderMarkdown(
                    formattedContent,
                    messageEl,
                    '',
                    this
                );
                
                // If it's an assistant message, add the action buttons
                if (message.role === 'assistant') {
                    this.addActionButtons(messageEl, message.content);
                }
            }
        } else {
            // Only show suggested prompts for empty chats
            this.addSuggestedPrompts(this.chatDisplay);
        }

        // Create the input area
        const inputContainer = this.containerEl.createEl('div', { cls: 'chat-input-container' });
        
        // Create text input
        this.inputField = inputContainer.createEl('textarea', { 
            cls: 'chat-input',
            attr: {
                placeholder: 'Ask Sidekick about your notes. Use [[ to mention specific notes.'
            }
        });

        // Create bottom buttons row
        const bottomButtonsRow = inputContainer.createEl('div', { cls: 'chat-bottom-buttons' });
        
        // Add model selector
        const modelSelectorContainer = bottomButtonsRow.createEl('div', { cls: 'chat-model-selector-container' });
        this.modelSelector = modelSelectorContainer.createEl('select', { cls: 'model-selector chat-model-selector' });
        
        // Add model options
        this.updateModelSelector();

        // Handle model selection changes
        this.modelSelector.addEventListener('change', async () => {
            this.plugin.settings.model = this.modelSelector.value;
            await this.plugin.saveSettings();
        });

        // Add send button
        const sendButton = bottomButtonsRow.createEl('button', { 
            cls: 'chat-send-button',
            attr: { 'aria-label': 'Send Message' }
        });
        sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-corner-down-left"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>`;

        // Handle note linking
        this.inputField.addEventListener('keydown', (event: KeyboardEvent) => {
            const cursorPosition = this.inputField.selectionStart;
            const textBeforeCursor = this.inputField.value.substring(0, cursorPosition);
            
            // Check if user typed [[ and no closing ]] yet
            if (event.key === '[' && 
                textBeforeCursor.endsWith('[') && 
                !textBeforeCursor.endsWith(']]')) {
                
                // Prevent the second [ from being typed (we'll add it ourselves)
                event.preventDefault();
                
                // Insert the second [ at cursor position
                const newPosition = cursorPosition + 1;
                this.inputField.value = 
                    textBeforeCursor + '[' + 
                    this.inputField.value.substring(cursorPosition);
                
                // Show note selector
                new NoteLinkSuggestModal(this.app, this.inputField, (file: TFile) => {
                    // Insert the note link
                    const link = `[[${file.path}]]`;
                    const beforeLink = this.inputField.value.substring(0, cursorPosition - 1);
                    const afterLink = this.inputField.value.substring(cursorPosition + 1);
                    this.inputField.value = beforeLink + link + afterLink;
                    
                    // Move cursor after the link
                    const newCursorPosition = beforeLink.length + link.length;
                    this.inputField.setSelectionRange(newCursorPosition, newCursorPosition);
                    this.inputField.focus();
                }).open();
            }
            // Handle Enter key for sending message
            else if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendButton.click();
            }
        });

        // Event listener for Send button
        sendButton.addEventListener('click', () => {
            const message = this.inputField.value.trim();
            if (message) {
                this.handleUserMessage(message, this.chatDisplay);
                this.inputField.value = '';
            }
        });

        // Add link handler to chat display
        this.setupLinkHandler(this.chatDisplay);

        // Add selection menu handler
        this.setupSelectionMenu();

        // Only update cursor position when editing a note
        this.registerEvent(
            this.app.workspace.on('editor-change', (editor) => {
                const view = this.app.workspace.getActiveViewOfType(MarkdownView);
                
                // Only update if we're in a markdown view (not the chat sidebar)
                if (view?.file && editor.hasFocus() && view.getViewType() === 'markdown') {
                    this.lastKnownCursorPosition = {
                        file: view.file,
                        position: editor.getCursor()
                    };
                }
            })
        );
    }

    private initializeOpenAI() {
        if (!this.openai && this.plugin.settings.openAIApiKey) {
            this.openai = new OpenAI({
                apiKey: this.plugin.settings.openAIApiKey,
                dangerouslyAllowBrowser: true
            });
        }
    }

    // Fix the analyzeConversationContinuity method
    private async analyzeConversationContinuity(newMessage: string, loadingMessage: HTMLElement): Promise<{
        isFollowUp: boolean;
        searchQuery: string;
        context: string;
    }> {
        // If there's no previous conversation, it's definitely not a follow-up
        if (this.chatHistory.length < 2) {
            return {
                isFollowUp: false,
                searchQuery: newMessage,
                context: newMessage
            };
        }

        // Get the last exchange
        const lastUserMessage = this.chatHistory[this.chatHistory.length - 2];  // Skip current message
        const lastAssistantMessage = this.chatHistory[this.chatHistory.length - 1];

        try {
            loadingMessage.innerText = 'Analyzing conversation context...';
            
            const response = await this.openai!.chat.completions.create({
                model: "gpt-4-0125-preview",
                messages: [
                    {
                        role: "system",
                        content: `Analyze the conversation continuity between messages. Determine if the new message is:
                        1. A follow-up/clarification of the previous topic
                        2. A new, unrelated topic
                        
                        Respond in JSON format:
                        {
                            "isFollowUp": boolean,
                            "explanation": string,
                            "searchQuery": string (if follow-up, combine relevant context from previous exchange with new query; if new topic, use just the new message)
                        }`
                    },
                    { role: "user", content: lastUserMessage.content },
                    { role: "assistant", content: lastAssistantMessage.content },
                    { role: "user", content: newMessage }
                ],
                temperature: 0.1,
            }, { signal: this.currentRequest?.signal });  // Add signal here

            const analysis = JSON.parse(response.choices[0].message.content!);
            
            return {
                isFollowUp: analysis.isFollowUp,
                searchQuery: analysis.searchQuery,
                context: analysis.isFollowUp ? 
                    `${lastUserMessage.content}\n${lastAssistantMessage.content}\n${newMessage}` :
                    newMessage
            };
        } catch (error) {
            console.error('Error analyzing conversation continuity:', error);
            // Fall back to using just the new message
            return {
                isFollowUp: false,
                searchQuery: newMessage,
                context: newMessage
            };
        }
    }

    async handleUserMessage(message: string, chatDisplay: HTMLElement): Promise<void> {
        if (!this.plugin.settings.openAIApiKey) {
            new Notice('Please set your OpenAI API key in settings.');
            return;
        }

        // Clear any existing suggested prompts
        const existingPrompts = chatDisplay.querySelector('.suggested-prompts-container');
        if (existingPrompts) {
            existingPrompts.remove();
        }

        // Create new AbortController for this request
        this.currentRequest = new AbortController();

        this.initializeOpenAI();

        // Remove reset message if it exists
        if (this.resetMessage) {
            this.resetMessage.remove();
            this.resetMessage = null;
        }

        // Format user message with clickable links
        const userMessage = chatDisplay.createDiv({ cls: 'chat-message user-message' });
        const formattedUserMessage = this.formatLinks(message);
        await MarkdownRenderer.renderMarkdown(
            formattedUserMessage,
            userMessage,
            '',
            this
        );

        // Add this: Get initial position of user message
        const userMessageInitialTop = userMessage.offsetTop;

        this.chatHistory.push({ role: 'user', content: message });

        // Scroll to show the user's message
        chatDisplay.scrollTop = chatDisplay.scrollHeight;

        // Add loading message
        const loadingMessage = chatDisplay.createDiv({ cls: 'chat-message assistant-message loading' });
        loadingMessage.innerText = 'Searching notes...';

        // Scroll again to show the loading message
        chatDisplay.scrollTop = chatDisplay.scrollHeight;

        try {
            // Add user message to thread first
            const currentThread = this.getCurrentThread();
            currentThread.messages.push({ role: 'user', content: message });
            await this.saveThreads();

            // First, analyze the conversation continuity
            const conversationAnalysis = await this.analyzeConversationContinuity(message, loadingMessage);
            
            // First, update the search results handling to properly merge explicit and semantic results
            loadingMessage.innerText = 'Searching notes...';

            // Get explicitly referenced notes first
            const explicitResults = await this.getExplicitlyReferencedNotes(message);
            
            // Then get semantic search results
            const semanticResults = await this.searchService.search(
                conversationAnalysis.searchQuery
            );

            // Merge results, prioritizing explicit references
            const searchResults = [
                ...explicitResults,  // Explicit references come first
                ...semanticResults.filter(result => 
                    // Only include semantic results that aren't already included as explicit references
                    result.score > 0.75 && !explicitResults.some(explicit => explicit.id === result.id)
                )
            ];

            // Format context from all results
            loadingMessage.innerText = 'Processing notes...';
            const referencedNotes = new Set<string>();
            
            const context = searchResults
                .map(result => {
                    referencedNotes.add(result.id);  // Add main note
                    const relevanceIndicator = result.explicit ? "Explicitly Referenced" : 
                        (result.score > 0.9 ? "Highly Relevant" : "Relevant");
                    
                    let contextText = `[File: ${result.id}] (${relevanceIndicator}`;
                    if (!result.explicit) {
                        contextText += `, score: ${result.score.toFixed(3)}`;
                    }
                    if (result.keywordScore) {
                        contextText += `, keyword relevance: ${result.keywordScore.toFixed(3)}`;
                    }
                    if (result.matchedKeywords?.length) {
                        contextText += `, matched terms: ${result.matchedKeywords.join(', ')}`;
                    }
                    contextText += ')\n\nRelevant Section:\n' + result.content;

                    // Add linked contexts if available
                    if (result.linkedContexts && result.linkedContexts.length > 0) {
                        contextText += '\n\nRelevant content from linked notes:\n';
                        result.linkedContexts.forEach((linked) => {
                            referencedNotes.add(linked.notePath);  // Add linked note
                            contextText += `\nFrom [[${linked.notePath}]] (relevance: ${linked.relevance.toFixed(3)}, link distance: ${linked.linkDistance}):
${linked.context}\n`;
                        });
                    }

                    return contextText;
                })
                .join('\n\n==========\n\n');

            // Update system prompt to include conversation analysis
            const systemPrompt = `${this.plugin.settings.systemPrompt}

MEMORY CONTEXT:
${this.plugin.settings.memory}

ABOUT THE USER:
${this.plugin.settings.personalInfo}

CURRENT DATE AND TIME:
${DateService.getCurrentDateHumanReadable()}
ISO Date: ${DateService.getCurrentDate()}

Conversation Analysis:
${conversationAnalysis.isFollowUp ? 
    "This is a follow-up question to the previous topic. Consider the previous context while maintaining focus on new information." : 
    "This is a new topic. Focus on providing fresh information without being constrained by the previous conversation."}

Current conversation context:
${this.chatHistory.slice(-3).map(msg => `${msg.role}: ${msg.content}`).join('\n')}

I am providing you with both relevant sections and their surrounding context from the user's notes. Each note is marked with its relevance score (higher is better).

Remember to:
1. ${conversationAnalysis.isFollowUp ? 
    "Build upon the previous conversation while incorporating new information from the notes" : 
    "Focus on the new topic without being constrained by the previous conversation"}
2. Look for new connections in the provided notes
3. When referencing notes, always use the double bracket format: [[note name]]
4. Use the provided current date/time when answering temporal questions (e.g., "today", "this month", etc.)

Here are the relevant notes:

${context}`;

            const apiMessages: ChatCompletionMessageParam[] = [
                { role: 'system', content: systemPrompt },
                ...this.chatHistory.map(msg => ({
                    role: msg.role,
                    content: msg.content
                })) as ChatCompletionMessageParam[]
            ];

            loadingMessage.innerText = 'Sending to OpenAI...';

            // Get streaming response from OpenAI with abort signal
            const response = await this.openai!.chat.completions.create({
                model: this.plugin.settings.model,
                messages: apiMessages,
                temperature: 0.7,
                stream: true
            }, { signal: this.currentRequest?.signal });  // Add signal here for the main chat response

            // Create message container for assistant's response
            const assistantMessage = chatDisplay.createDiv({ cls: 'chat-message assistant-message' });
            let fullResponse = '';

            // Remove loading message once we start receiving the stream
            loadingMessage.remove();

            // Create a temporary div for rendering markdown
            const markdownRenderingDiv = assistantMessage.createDiv();

            // Handle streaming response
            for await (const chunk of response) {
                const content = chunk.choices[0]?.delta?.content || '';
                fullResponse += content;
                
                // Clear and re-render the markdown
                markdownRenderingDiv.empty();
                const formattedResponse = this.formatLinks(fullResponse);
                await MarkdownRenderer.renderMarkdown(
                    formattedResponse,
                    markdownRenderingDiv,
                    '',
                    this
                );
                
                // Modified scrolling logic:
                // Get positions relative to viewport
                const userMessageRect = userMessage.getBoundingClientRect();
                const chatDisplayRect = chatDisplay.getBoundingClientRect();
                
                // Calculate if we should scroll
                // Add a small offset (e.g., 20px) to keep the user message visible
                const offsetFromTop = 24;
                const shouldScroll = (userMessageRect.top - offsetFromTop) > chatDisplayRect.top;
                
                if (shouldScroll) {
                    chatDisplay.scrollTop = chatDisplay.scrollHeight;
                }
            }

            // After the response is complete
            if (fullResponse) {
                markdownRenderingDiv.empty();
                
                // Add context footer
                const contextFooter = referencedNotes.size > 0 
                    ? `\n\n---\n<div class="context-footer">\n\nBased on the following context:\n${Array.from(referencedNotes).map(path => `- [[${path}]]`).join('\n')}\n</div>`
                    : '';

                const responseWithFooter = `${fullResponse}${contextFooter}`;
                const formattedResponse = this.formatLinks(responseWithFooter);
                await MarkdownRenderer.renderMarkdown(
                    formattedResponse,
                    markdownRenderingDiv,
                    '',
                    this
                );

                // Add action buttons and process response
                this.addActionButtons(assistantMessage, fullResponse);
                await this.processResponse(fullResponse);
                this.chatHistory.push({ role: 'assistant', content: fullResponse });
                
                // Add assistant message to thread
                currentThread.messages.push({ role: 'assistant', content: fullResponse });
                currentThread.lastModified = Date.now();
                await this.saveThreads();

                // Generate thread title and update memory
                await this.afterAssistantReply();
                await this.analyzeConversationForMemory(this.chatHistory.slice(-2));

                // Limit chat history
                if (this.chatHistory.length > 20) {
                    this.chatHistory = this.chatHistory.slice(-20);
                }
            }

        } catch (error: any) {
            console.error('Error:', error);
            loadingMessage.remove();

            // Don't show error message if request was intentionally aborted
            if (error.name === 'AbortError') {
                return;
            }

            if (error.response?.status === 429) {
                new Notice('Rate limit exceeded. Please try again later.');
            } else {
                new Notice('Failed to get response from OpenAI.');
            }

            const errorMessage = chatDisplay.createDiv({ cls: 'chat-message assistant-message error' });
            errorMessage.innerText = 'Sorry, there was an error processing your request.';
        } finally {
            this.currentRequest = null;
        }
    }

    private async getExplicitlyReferencedNotes(message: string): Promise<SearchResult[]> {
        const linkRegex = /\[\[(.*?)\]\]/g;
        const matches = [...message.matchAll(linkRegex)];
        const results: SearchResult[] = [];

        for (const match of matches) {
            const path = match[1];
            const file = this.app.vault.getAbstractFileByPath(path);
            
            if (file instanceof TFile) {
                try {
                    const content = await this.app.vault.read(file);
                    results.push({
                        id: file.path,
                        score: 1.0,  // Maximum relevance for explicitly referenced notes
                        content: content,
                        explicit: true,
                        matchedKeywords: [],  // Initialize empty arrays for consistency
                        linkedContexts: []
                    });
                } catch (error) {
                    console.error(`Error reading file ${path}:`, error);
                }
            }
        }

        return results;
    }

    private async resetChat() {
        // Cancel any ongoing request
        if (this.currentRequest) {
            this.currentRequest.abort();
            this.currentRequest = null;
        }

        // Save current thread if it has messages
        const currentThread = this.getCurrentThread();
        if (currentThread.messages.length > 0) {
            currentThread.lastModified = Date.now();
            await this.saveThreads();
        }

        // Create new thread
        this.currentThreadId = this.createNewThread();
        this.chatHistory = [];  // Keep this for compatibility
        
        // Clear display
        this.chatDisplay.empty();
        
        // Add buttons container with both buttons
        const buttonContainer = this.chatDisplay.createDiv({ cls: 'chat-buttons-container' });
        const threadSelector = this.createThreadHistoryButton();
        const resetButton = this.createResetButton();
        buttonContainer.appendChild(threadSelector);
        buttonContainer.appendChild(resetButton);
        
        // // Show reset message
        // this.resetMessage = this.chatDisplay.createDiv({ cls: 'chat-message system-message' });
        // await MarkdownRenderer.renderMarkdown(
        //     '*New chat thread started.*',
        //     this.resetMessage,
        //     '',
        //     this
        // );

        // Add suggested prompts to chat display
        this.addSuggestedPrompts(this.chatDisplay);
    }

    // Add new method for creating thread selector
    private addThreadSelector() {
        const threadSelector = this.chatDisplay.createEl('button', {
            cls: 'thread-selector-button',
            attr: { 'aria-label': 'View Chat History' }
        });
        threadSelector.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>`;
        
        threadSelector.addEventListener('click', (e: MouseEvent) => {
            this.showThreadHistory(e);
        });
    }

    // Add method for showing thread history
    private async showThreadHistory(position: { x: number, y: number }) {
        console.log('showThreadHistory called with position:', position);
        console.log('Current threads:', this.threads);
        
        try {
            const dropdown = new ThreadHistoryDropdown(
                this.app,
                this.threads,
                async (threadId: string) => {
                    await this.loadThread(threadId);
                },
                position
            );

            console.log('Dropdown created, calling show()');
            await dropdown.show();
            console.log('Dropdown show() completed');
        } catch (error) {
            console.error('Error showing thread history:', error);
        }
    }

    // Add method for loading a specific thread
    private async loadThread(threadId: string) {
        const thread = this.threads.find(t => t.id === threadId);
        if (!thread) return;

        this.currentThreadId = threadId;
        this.chatHistory = thread.messages;
        
        // Clear display but save buttons
        const oldButtonContainer = this.chatDisplay.querySelector('.chat-buttons-container');
        this.chatDisplay.empty();
        if (oldButtonContainer) {
            this.chatDisplay.appendChild(oldButtonContainer);
        }
        
        // Render messages
        for (const message of thread.messages) {
            const messageEl = this.chatDisplay.createDiv({
                cls: `chat-message ${message.role}-message`
            });
            await MarkdownRenderer.renderMarkdown(
                this.formatLinks(message.content),
                messageEl,
                '',
                this
            );
            
            if (message.role === 'assistant') {
                this.addActionButtons(messageEl, message.content);
            }
        }
    }

    async onClose(): Promise<void> {
        // Cancel any ongoing request when closing the view
        if (this.currentRequest) {
            this.currentRequest.abort();
            this.currentRequest = null;
        }
        return Promise.resolve();
    }

    private updateModelSelector() {
        if (!this.modelSelector) return;
        
        // Clear existing options
        this.modelSelector.empty();
        
        // Add model options
        AVAILABLE_MODELS.forEach(model => {
            const option = this.modelSelector.createEl('option', {
                value: model.value,
                text: model.label
            });
            if (model.value === this.plugin.settings.model) {
                option.selected = true;
            }
        });
    }

    private async processResponse(response: string) {
        try {
            // Check if response contains a memory update
            const memoryUpdateMatch = response.match(/\{\"memory_update\"\s*:\s*\"([^\"]+)\"\}/);
            if (memoryUpdateMatch) {
                const newMemory = memoryUpdateMatch[1];
                // Append the new memory to existing memory
                this.plugin.settings.memory = this.plugin.settings.memory.trim() + '\n' + newMemory;
                await this.plugin.saveSettings();
                
                // Remove the JSON object from the response
                response = response.replace(/\{\"memory_update\"\s*:\s*\"([^\"]+)\"\}/, '');
            }
        } catch (error) {
            console.error('Error processing response:', error);
        }
    }

    // Fix the analyzeConversationForMemory method
    private async analyzeConversationForMemory(conversation: ChatMessage[]) {
        try {
            const response = await this.openai!.chat.completions.create({
                model: "gpt-4-0125-preview",
                messages: [
                    {
                        role: "system",
                        content: `You are a memory analyzer. Review this conversation and determine what should be remembered which is not already in the user's notes.

CURRENT MEMORY:
${this.plugin.settings.memory}

Guidelines:
1. Separate the user's query from the context sent to you from the retrieved notes. Look for information in the user's query which is NOT in the note context sent to you.
   - Personal details (relationships, preferences, habits)
   - Projects and work
   - Connections between notes
   - Important dates or facts
2. Don't repeat information that's already in memory
3. If you find contradictions with existing memory, update with the newer information
4. Use [[note.md]] syntax when referencing notes

Output Format:
If you find new information: {"memory_update": "new information"}
If information contradicts existing: {"memory_update": "CORRECTION: new correct information"}
If no new information: {"memory_update": null}

Example updates:
{"memory_update": "User's project [[Thesis.md]] has a deadline in June 2024"}
{"memory_update": "CORRECTION: User's sister Sarah (previously noted as Jenny) enjoys hiking"}`
                    },
                    ...conversation.map(msg => ({
                        role: msg.role,
                        content: msg.content
                    }))
                ],
                temperature: 0.1,
            }, { signal: this.currentRequest?.signal });  // Add signal here

            const memoryUpdate = response.choices[0].message.content;
            if (memoryUpdate && memoryUpdate.includes('"memory_update"')) {
                await this.processResponse(memoryUpdate);
            }
        } catch (error) {
            console.error('Error analyzing conversation for memory:', error);
        }
    }

    private addActionButtons(messageEl: HTMLElement, content: string) {
        const buttonsContainer = messageEl.createDiv({ cls: 'action-buttons' });
        
        // Create buttons in consistent order
        const buttons = [];
        buttons.push({
            tooltip: 'Create new',
            onClick: () => this.createNewNote(content)
        });
        
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
            buttons.push({
                tooltip: 'Add to open note',
                onClick: () => this.appendToCurrentNote(content)
            });
            
            // // Add insert at cursor button only if there's an active file
            // buttons.push({
            //     tooltip: 'Insert at cursor',
            //     onClick: () => this.insertAtCursor(content)
            // });
        }

        // Add copy button
        buttons.push({
            tooltip: 'Copy to clipboard',
            onClick: () => {
                navigator.clipboard.writeText(content);
                new Notice('Copied to clipboard');
            }
        });

        // Create buttons
        buttons.forEach(({ tooltip, onClick }) => {
            const button = this.createActionButton(tooltip, onClick);
            buttonsContainer.appendChild(button);
        });
    }

    private createActionButton(tooltip: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.className = 'action-button';
        button.setAttribute('aria-label', tooltip);
        button.addEventListener('click', onClick);

        // Add appropriate icon based on tooltip
        if (tooltip === 'Create new') {
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`;
        } else if (tooltip === 'Add to open note') {
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h14a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v4"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M2 15h10"/><path d="m9 18 3-3-3-3"/></svg>`;
        } else if (tooltip === 'Copy to clipboard') {
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>`;
        } else if (tooltip === 'Insert at cursor') {
            button.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 22h-1a4 4 0 0 1-4-4V6a4 4 0 0 1 4-4h1"/><path d="M7 22h1a4 4 0 0 0 4-4V6a4 4 0 0 0-4-4H7"/><line x1="7" y1="12" x2="17" y2="12"/></svg>`;
        }

        return button;
    }

    private setupSelectionMenu() {
        document.addEventListener('selectionchange', () => {
            // Remove any existing selection menu
            document.querySelectorAll('.selection-menu').forEach(el => el.remove());

            const selection = window.getSelection();
            if (!selection || selection.isCollapsed) return;

            const range = selection.getRangeAt(0);
            const selectedText = selection.toString().trim();
            if (!selectedText) return;

            // Check if selection is within a chat message
            const messageEl = (range.commonAncestorContainer as HTMLElement).closest?.('.assistant-message') 
                || (range.commonAncestorContainer.parentElement as HTMLElement).closest('.assistant-message');
            if (!messageEl) return;

            const rect = range.getBoundingClientRect();
            const menu = document.createElement('div');
            menu.className = 'selection-menu';

            // Create buttons in same order as hover buttons
            const newNoteButton = this.createActionButton('Create new', () => 
                this.createNewNote(selectedText));
            menu.appendChild(newNoteButton);

            const activeFile = this.app.workspace.getActiveFile();
            if (activeFile) {
                const appendButton = this.createActionButton('Add to open note', () => 
                    this.appendToCurrentNote(selectedText));
                menu.appendChild(appendButton);
            }

            // Add copy button
            const copyButton = this.createActionButton('Copy to clipboard', () => {
                navigator.clipboard.writeText(selectedText);
                new Notice('Copied to clipboard');
                menu.remove();  // Remove menu after copying
            });
            menu.appendChild(copyButton);

            // Position menu at top-right of selection
            menu.style.position = 'fixed';
            menu.style.left = `${rect.right}px`;
            menu.style.top = `${rect.top}px`;

            document.body.appendChild(menu);

            // Remove menu when clicking outside
            const hideMenu = (e: MouseEvent) => {
                if (!menu.contains(e.target as Node)) {
                    menu.remove();
                    document.removeEventListener('mousedown', hideMenu);
                }
            };
            document.addEventListener('mousedown', hideMenu);
        });
    }

    // Fix the createNewNote method
    private async createNewNote(content: string) {
        try {
            // Get title suggestion from LLM
            const titleResponse = await this.openai!.chat.completions.create({
                model: "gpt-4-0125-preview",
                messages: [
                    {
                        role: "system",
                        content: `Create a concise but descriptive title for a note containing this content. 
                        The title should be:
                        - Clear and descriptive
                        - 2-6 words long
                        - Use title case
                        - No special characters except spaces and hyphens
                        - No file extension
                        
                        Output the title alone with no additional text or punctuation.`
                    },
                    {
                        role: "user",
                        content: content
                    }
                ],
                temperature: 0.3,
            }, { signal: this.currentRequest?.signal });  // Add signal here

            const suggestedTitle = titleResponse.choices[0].message.content?.trim() || 'Chat Export';
            const fileName = `${suggestedTitle}.md`;

            // Create the note
            const file = await this.app.vault.create(fileName, content);
            
            // Open the new note
            const leaf = this.app.workspace.getLeaf('tab');
            await leaf.openFile(file);
            
            new Notice('Note created successfully');
        } catch (error) {
            console.error('Error creating note:', error);
            new Notice('Failed to create note');
            
            // Fallback to timestamp-based name if title generation fails
            try {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                const fileName = `Chat Export ${timestamp}.md`;
                const file = await this.app.vault.create(fileName, content);
                const leaf = this.app.workspace.getLeaf('tab');
                await leaf.openFile(file);
                new Notice('Note created with default title');
            } catch (fallbackError) {
                console.error('Error in fallback note creation:', fallbackError);
                new Notice('Failed to create note');
            }
        }
    }

    private async appendToCurrentNote(content: string) {
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) return;

        try {
            const currentContent = await this.app.vault.read(activeFile);
            const newContent = `${currentContent}\n\n${content}`;
            await this.app.vault.modify(activeFile, newContent);
            
            new Notice('Content added to note');
        } catch (error) {
            console.error('Error appending to note:', error);
            new Notice('Failed to add content to note');
        }
    }

    private createNewThread(): string {
        const threadId = `thread-${Date.now()}`;
        this.threads.push({
            id: threadId,
            messages: [],
            createdAt: Date.now(),
            lastModified: Date.now(),
            title: 'New Conversation',
        });
        return threadId;
    }

    private getCurrentThread(): ChatThread {
        return this.threads.find(t => t.id === this.currentThreadId) || this.threads[0];
    }

    private async saveThreads() {
        await this.plugin.saveThreads(this.threads);
    }

    private async loadThreads() {
        const savedThreads = await this.plugin.loadThreads() || [];
        this.threads = savedThreads;
        if (this.threads.length === 0) {
            this.currentThreadId = this.createNewThread();
        } else {
            this.currentThreadId = this.threads[this.threads.length - 1].id;
        }
    }

    private createResetButton(): HTMLButtonElement {
        const resetButton = document.createElement('button');
        resetButton.className = 'chat-actions-button';
        resetButton.setAttribute('aria-label', 'Start new chat');
        resetButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
        resetButton.addEventListener('click', () => this.resetChat());
        return resetButton;
    }

    private createThreadHistoryButton(): HTMLButtonElement {
        const threadSelector = document.createElement('button');
        threadSelector.className = 'chat-actions-button';
        threadSelector.setAttribute('aria-label', 'View Chat History');
        threadSelector.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width: 18px; height: 18px;"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>`;
        
        threadSelector.addEventListener('click', (e: MouseEvent) => {
            // Get the mouse event coordinates instead of button position
            const position = {
                x: e.pageX,
                y: e.pageY
            };
            
            console.log('Button clicked at position:', position);
            this.showThreadHistory(position);
        });
        return threadSelector;
    }

    private async afterAssistantReply(): Promise<void> {
        const thread = this.getCurrentThread();
        // If this thread still has the default title and we have at least 2 messages (user and assistant)
        if (thread?.title === 'New Conversation' && thread.messages.length >= 2) {
            // Grab the first user message
            const userMsg = thread.messages.find(m => m.role === 'user')?.content || '';
            
            try {
                // OpenAI client should be initialized at this point
                if (!this.openai) {
                    console.error('OpenAI client is not initialized');
                    return;
                }

                // Generate thread title using OpenAI
                const response = await this.openai.chat.completions.create({
                    model: "gpt-3.5-turbo",
                    messages: [
                        {
                            role: "system",
                            content: "Generate a very brief (2-4 words) title for this chat based on the first message. Return only the title, no quotes or punctuation."
                        },
                        {
                            role: "user",
                            content: userMsg
                        }
                    ],
                    temperature: 0.7,
                    max_tokens: 10
                });

                const generatedTitle = response.choices[0].message?.content?.trim() || 'Untitled Chat';
                thread.title = generatedTitle;
                // Save the updated thread to persist new title
                await this.saveThreads();

            } catch (error) {
                console.error('Error generating thread title:', error);
                thread.title = 'Untitled Chat';
                // Save the updated thread even if there was an error
                await this.saveThreads();
            }
        }
    }

    private getRandomPrompts(count: number): string[] {
        const prompts = [...this.plugin.settings.suggestedPrompts];
        const result: string[] = [];
        
        while (result.length < count && prompts.length > 0) {
            const randomIndex = Math.floor(Math.random() * prompts.length);
            result.push(prompts[randomIndex]);
            prompts.splice(randomIndex, 1);
        }
        
        return result;
    }

    private addSuggestedPrompts(container: HTMLElement) {
        const promptsContainer = container.createDiv({ cls: 'suggested-prompts-container' });
        promptsContainer.createDiv({ cls: 'suggested-prompts-header', text: 'Explore your notes' });
        
        const promptsDiv = promptsContainer.createDiv({ cls: 'suggested-prompts' });
        
        const randomPrompts = this.getRandomPrompts(3);
        
        randomPrompts.forEach(prompt => {
            const button = promptsDiv.createEl('button', {
                cls: 'suggested-prompt-button',
                text: prompt
            });
            
            button.addEventListener('click', () => {
                this.inputField.value = prompt;
                this.inputField.focus();
                this.inputField.setSelectionRange(prompt.length, prompt.length);
            });
        });
    }

    private async insertAtCursor(content: string) {
        const activeFile = this.app.workspace.getActiveFile();
        
        if (!activeFile) {
            new Notice('No active file');
            return;
        }

        // If we have a cached position for this file, use it
        if (this.lastKnownCursorPosition && 
            this.lastKnownCursorPosition.file.path === activeFile.path) {
            
            const view = this.app.workspace.getActiveViewOfType(MarkdownView);
            if (!view) {
                new Notice('No active editor');
                return;
            }

            const editor = view.editor;
            
            try {
                editor.replaceRange('\n' + content + '\n', this.lastKnownCursorPosition.position);
                new Notice('Content inserted at cursor position');
            } catch (error) {
                console.error('Error inserting at cursor:', error);
                new Notice('Failed to insert content');
            }
        } else {
            // If we don't have a cached position, fall back to appending at the end
            await this.appendToCurrentNote(content);
        }
    }
}