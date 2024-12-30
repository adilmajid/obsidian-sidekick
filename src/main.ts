import { Plugin, WorkspaceLeaf, Notice, App, Modal, Setting, TFile, Vault } from 'obsidian';
import { ChatSidebarView, VIEW_TYPE_CHAT_SIDEBAR } from './ChatSidebarView';
import { ChatSidebarSettingTab } from './settings-tab';
import { ChatSidebarSettings, DEFAULT_SETTINGS } from './settings';
import { generateEmbedding, initializeOpenAI } from './embeddingHelper';
import { saveEmbedding, getAllEmbeddings } from './storageService';
import { ChatThread, ThreadStorage } from './types';

declare global {
    interface Window {
        require: (module: string) => any;
    }
}

class EmbeddingProgressModal extends Modal {
    progress: number;
    total: number;
    intervalId: any;
    onPause: () => void;
    onStop: () => void;

    constructor(app: App, total: number, onPause: () => void, onStop: () => void) {
        super(app);
        this.progress = 0;
        this.total = total;
        this.onPause = onPause;
        this.onStop = onStop;
    }

    onOpen() {
        let { contentEl } = this;
        contentEl.createEl('h2', { text: 'Indexing Notes...' });

        this.progressEl = contentEl.createEl('p', { text: `Progress: 0/${this.total}` });

        const pauseButton = contentEl.createEl('button', { text: 'Pause' });
        pauseButton.addEventListener('click', () => {
            this.onPause();
            this.close();
        });

        const stopButton = contentEl.createEl('button', { text: 'Stop' });
        stopButton.addEventListener('click', () => {
            this.onStop();
            this.close();
        });
    }

    updateProgress(current: number) {
        this.progress = current;
        this.progressEl.setText(`Progress: ${this.progress}/${this.total}`);
    }

    private progressEl: HTMLElement;
}

export default class ObsidianChatSidebar extends Plugin {
    settings: ChatSidebarSettings;
    isIndexing: boolean = false;
    pauseIndexing: boolean = false;
    stopIndexing: boolean = false;
    embeddingModal: EmbeddingProgressModal | null = null;
    embeddingInterval: any;
    private currentNotification: Notice | null = null;
    private settingsTab: ChatSidebarSettingTab | null = null;
    private safeStorage: any;

    async onload() {
        console.log('Loading ObsidianChatSidebar plugin');

        // Initialize safeStorage at plugin load - new approach
        try {
            const electron = (window as any).require('electron');
            if (electron?.remote) {
                this.safeStorage = electron.remote.safeStorage;
            } else {
                this.safeStorage = electron.safeStorage;
            }
            console.log('SafeStorage initialized:', !!this.safeStorage);
        } catch (error) {
            console.error('Failed to initialize safeStorage:', error);
            this.safeStorage = null;
        }

        // Register view first
        this.registerView(
            VIEW_TYPE_CHAT_SIDEBAR,
            (leaf: WorkspaceLeaf) => new ChatSidebarView(leaf, this)
        );

        await this.loadSettings();

        // Add a command to start embedding manually (optional)
        this.addCommand({
            id: 'start-embedding',
            name: 'Start Indexing Notes',
            callback: () => {
                this.startEmbeddingProcess();
            },
        });

        // Automatically start embedding on plugin load if embeddings are empty
        const embeddings = await getAllEmbeddings();
        if (embeddings.length === 0) {
            this.startEmbeddingProcess();
        }

        // Listen to vault events for incremental updates
        this.registerEvent(this.app.vault.on('modify', (file: TFile) => {
            if (file.extension === 'md') {
                this.handleFileChange(file);
            }
        }));

        this.registerEvent(this.app.vault.on('create', (file: TFile) => {
            if (file.extension === 'md') {
                this.handleFileChange(file);
            }
        }));

        // Scheduled embedding updates
        this.scheduleEmbeddingUpdates();

        // Store reference to settings tab
        this.settingsTab = new ChatSidebarSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        // Add ribbon icon
        this.addRibbonIcon('messages-square', 'Open Sidekick Chat', () => {
            this.activateView();
        });

        // Add command to command palette
        this.addCommand({
            id: 'open-sidekick-chat',
            name: 'Open Sidekick Chat',
            callback: () => {
                this.activateView();
            }
        });
    }

    async onunload() {
        console.log('Unloading ObsidianChatSidebar plugin');
        // Properly clean up views
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT_SIDEBAR);
        
        if (this.embeddingInterval) {
            clearInterval(this.embeddingInterval);
        }
    }

    async loadSettings() {
        const data = await this.loadData();
        console.log('Loading settings, encrypted key exists:', !!data?.encryptedApiKey);
        
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);

        // Decrypt API key if it exists
        if (data?.encryptedApiKey) {
            try {
                const decrypted = this.safeStorage.decryptString(
                    Buffer.from(data.encryptedApiKey, 'base64')
                );
                console.log('Successfully decrypted API key, exists:', !!decrypted);
                this.settings.openAIApiKey = decrypted || '';
                
                // Verify the key is set
                console.log('API key set in settings:', !!this.settings.openAIApiKey);
                
                // Re-initialize OpenAI client with decrypted key
                if (this.settings.openAIApiKey) {
                    try {
                        await initializeOpenAI(this.settings.openAIApiKey);
                        console.log('Successfully re-initialized OpenAI client');
                    } catch (error) {
                        console.error('Failed to initialize OpenAI client:', error);
                    }
                }
            } catch (error) {
                console.error('Failed to decrypt API key:', error);
                this.settings.openAIApiKey = '';
            }
        }
    }

    async saveSettings() {
        try {
            if (this.settings.openAIApiKey?.trim()) {
                console.log('Attempting to encrypt API key...');
                
                // Try to initialize safeStorage again if it failed before
                if (!this.safeStorage) {
                    try {
                        const electron = (window as any).require('electron');
                        this.safeStorage = electron.safeStorage || electron.remote.safeStorage;
                    } catch (error) {
                        console.error('Failed to initialize safeStorage (retry):', error);
                        throw new Error('Encryption service not available');
                    }
                }

                const encrypted = this.safeStorage.encryptString(this.settings.openAIApiKey);
                console.log('Successfully encrypted API key');
                
                const { openAIApiKey, ...otherSettings } = this.settings;
                const dataToSave = {
                    ...otherSettings,
                    encryptedApiKey: encrypted.toString('base64')
                };
                console.log('About to save data:', { ...dataToSave, encryptedApiKey: '[REDACTED]' });
                
                await this.saveData(dataToSave);
                console.log('Successfully saved encrypted data');
            } else {
                console.log('No API key to encrypt, saving other settings...');
                const { openAIApiKey, ...otherSettings } = this.settings;
                await this.saveData(otherSettings);
                console.log('Successfully saved settings without API key');
            }
            
            dispatchEvent(new CustomEvent('chat:settings-changed'));
        } catch (error) {
            console.error('Detailed save error:', error);
            if (this.settings.openAIApiKey?.trim()) {
                console.error('Failed to encrypt API key:', error);
                new Notice('Failed to save API key securely. Please try again.');
            }
        }
    }

    async startEmbeddingProcess() {
        if (this.isIndexing) {
            console.log('Already indexing, returning early');
            new Notice('Indexing is already in progress.');
            return;
        }

        if (!this.settings.openAIApiKey) {
            new Notice('Please set your OpenAI API key in settings first.');
            return;
        }

        this.isIndexing = true;
        this.pauseIndexing = false;
        this.stopIndexing = false;

        const files = this.app.vault.getMarkdownFiles().filter(file => {
            // Check if the file's path starts with any excluded folder
            return !this.settings.excludedFolders.some(folder => 
                file.path.startsWith(folder)
            );
        });

        console.log(`Found ${files.length} total markdown files (after exclusions)`);

        const existingEmbeddings = await getAllEmbeddings();
        console.log(`Found ${existingEmbeddings.length} existing embeddings`);
        
        const embeddingMap = new Map(existingEmbeddings.map(e => [e.id, e]));
        
        const filesToProcess = files.filter(file => {
            const existing = embeddingMap.get(file.path);
            return !existing || file.stat.mtime > (existing.lastModified || 0);
        });

        console.log(`Need to process ${filesToProcess.length} files`);

        if (filesToProcess.length === 0) {
            console.log('No files to process, returning early');
            new Notice('All notes are up to date.');
            this.isIndexing = false;
            return;
        }

        let current = 0;
        const total = filesToProcess.length;

        for (const file of filesToProcess) {
            if (this.stopIndexing) {
                console.log('Stopping indexing by user request');
                new Notice('Indexing stopped by user.');
                break;
            }

            while (this.pauseIndexing) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }

            console.log(`Processing file: ${file.path}`);
            const content = await this.app.vault.read(file);
            try {
                const embedding = await generateEmbedding(content, this.settings.openAIApiKey);
                console.log(`Generated embedding for ${file.path}`);
                
                await saveEmbedding({ 
                    id: file.path, 
                    embedding,
                    lastModified: file.stat.mtime 
                });
                console.log(`Saved embedding for ${file.path}`);
                
                current++;
                console.log(`Processed ${current}/${total} files`);
                
                // Update notification
                if (this.currentNotification) {
                    this.currentNotification.hide();
                }
                this.currentNotification = new Notice(`Indexed ${current}/${total} notes`);

                // Force refresh settings tab
                if (this.settingsTab) {
                    console.log('Refreshing settings tab');
                    await this.settingsTab.display();
                }
            } catch (error: any) {
                console.error(`Error embedding ${file.path}:`, error);
                if (error.message.includes('API key')) {
                    new Notice(error.message);
                    this.stopIndexing = true;
                    this.isIndexing = false;
                    break;
                }
                // Continue with next file if there's an error with this one
            }
        }

        console.log('Finished indexing process');
        this.isIndexing = false;
        if (this.currentNotification) {
            this.currentNotification.hide();
        }
        new Notice('Indexing completed.');
        
        // Final refresh of settings tab
        if (this.settingsTab && this.settingsTab.containerEl.isShown()) {
            await this.settingsTab.display();
        }
    }

    pauseEmbedding() {
        this.pauseIndexing = true;
        new Notice('Indexing paused.');
    }

    stopEmbedding() {
        this.stopIndexing = true;
        this.isIndexing = false;
        new Notice('Indexing stopping...');
        
        // Force refresh settings tab
        if (this.settingsTab) {
            this.settingsTab.display();
        }
    }

    async handleFileChange(file: TFile) {
        if (this.isIndexing) {
            new Notice('Indexing in progress. Please wait.');
            return;
        }

        const content = await this.app.vault.read(file);
        try {
            const embedding = await generateEmbedding(content, this.settings.openAIApiKey);
            await saveEmbedding({ 
                id: file.path, 
                embedding,
                lastModified: file.stat.mtime 
            });
        } catch (error) {
            console.error(`Error embedding ${file.path}:`, error);
        }
    }

    scheduleEmbeddingUpdates() {
        const intervalMinutes = this.settings.embeddingUpdateInterval;
        const intervalMs = intervalMinutes * 60 * 1000;

        this.embeddingInterval = setInterval(() => {
            this.startEmbeddingProcess();
        }, intervalMs);
    }

    async activateView() {
        const { workspace } = this.app;
        let leaf: WorkspaceLeaf | null = null;
        
        // Find existing view
        const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT_SIDEBAR);
        if (leaves.length > 0) {
            leaf = leaves[0];
        } else {
            // Create new leaf
            leaf = workspace.getRightLeaf(false);
            if (leaf) {
                await leaf.setViewState({
                    type: VIEW_TYPE_CHAT_SIDEBAR,
                    active: true,
                });
            }
        }

        // Reveal the leaf if it exists
        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    async saveData(data: any): Promise<void> {
        await super.saveData(data);
    }

    async loadData(): Promise<any> {
        return await super.loadData();
    }

    async saveThreads(threads: ChatThread[]): Promise<void> {
        try {
            const storage: ThreadStorage = {
                version: 1,
                threads: threads
            };
            await this.app.vault.adapter.write(
                `${this.manifest.dir}/chat-threads.json`,
                JSON.stringify(storage)
            );
        } catch (error) {
            console.error('Error saving threads:', error);
            new Notice('Failed to save chat threads');
        }
    }

    async loadThreads(): Promise<ChatThread[]> {
        try {
            const data = await this.app.vault.adapter.read(
                `${this.manifest.dir}/chat-threads.json`
            );
            const storage = JSON.parse(data) as ThreadStorage;
            
            // Handle version upgrades here if needed in the future
            if (!storage.version) {
                // Legacy data without version
                return Array.isArray(storage) ? storage : [];
            }
            
            return storage.threads;
        } catch {
            return [];
        }
    }
}
