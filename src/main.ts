import { Plugin, WorkspaceLeaf, Notice, App, Modal, TFile, Platform } from 'obsidian';
import { ChatSidebarView, VIEW_TYPE_CHAT_SIDEBAR } from './ChatSidebarView';
import { ChatSidebarSettingTab } from './settings-tab';
import { ChatSidebarSettings, DEFAULT_SETTINGS } from './settings';
import { generateEmbedding, initializeOpenAI } from './embeddingHelper';
import { saveEmbedding, getAllEmbeddings, deleteEmbedding } from './storageService';
import { ChatThread, ThreadStorage } from './types';
import { EncryptionHelper } from './encryption';
import { AudioControls } from './components/AudioControls';
import { MarkdownView } from 'obsidian';
import { DateService } from './services/DateService';
import { DateIndex } from './services/DateIndex';

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
    private audioControls: AudioControls;
    private pendingFileChanges: Set<string> = new Set();
    private fileChangeTimeout: NodeJS.Timeout | null = null;
    dateIndex: DateIndex;

    async onload() {
        console.log('Loading ObsidianChatSidebar plugin');
        console.log('Current date from DateService:', DateService.getCurrentDateHumanReadable());

        // Initialize DateIndex
        this.dateIndex = new DateIndex(this.app.vault);

        // Register view first
        this.registerView(
            VIEW_TYPE_CHAT_SIDEBAR,
            (leaf: WorkspaceLeaf) => new ChatSidebarView(leaf, this)
        );

        await this.loadSettings();

        // Migration: Add suggestedPrompts if missing
        if (!this.settings.suggestedPrompts) {
            this.settings.suggestedPrompts = DEFAULT_SETTINGS.suggestedPrompts;
            await this.saveSettings();
        }

        // Add a command to start embedding manually (optional)
        this.addCommand({
            id: 'start-embedding',
            name: 'Start Indexing Notes',
            callback: () => {
                this.startEmbeddingProcess();
            },
        });

        // Wait for Obsidian to fully load before accessing files
        this.app.workspace.onLayoutReady(() => {
            // Debug vault access after layout is ready
            console.log('\n=== VAULT ACCESS CHECK (after layout ready) ===');
            console.log('- Vault object exists:', !!this.app.vault);
            console.log('- Files in vault:', this.app.vault.getFiles().length);
            console.log('- Markdown files in vault:', this.app.vault.getMarkdownFiles().length);

            // Now check embeddings and start processing if needed
            this.initializeEmbeddings();
        });

        // Store reference to settings tab
        this.settingsTab = new ChatSidebarSettingTab(this.app, this);
        this.addSettingTab(this.settingsTab);

        // Just keep the chat sidebar icon
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

        // Register the audio controls for note headers
        this.registerEvent(
            this.app.workspace.on('file-open', (file) => {
                if (!file) {
                    console.log('No file opened');
                    return;
                }

                // Get the active leaf (current note view)
                const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView);
                if (!activeLeaf) {
                    console.log('No active markdown view');
                    return;
                }

                // Get the actions container (where bookmark and more options buttons are)
                const actionsEl = activeLeaf.containerEl.querySelector('.view-actions') as HTMLElement;
                if (!actionsEl) {
                    console.log('Could not find actions element');
                    return;
                }

                console.log('Found actions element:', actionsEl);

                // Create our audio controls container
                if (!actionsEl.querySelector('.audio-controls')) {
                    console.log('Creating new audio controls');
                    this.audioControls = new AudioControls(
                        this.app,
                        actionsEl,
                        this.settings
                    );
                    
                    // Make sure our controls are the first child
                    if (actionsEl.firstChild) {
                        actionsEl.insertBefore(this.audioControls.containerEl, actionsEl.firstChild);
                    } else {
                        actionsEl.appendChild(this.audioControls.containerEl);
                    }
                    
                    this.audioControls.updateFile(file);
                } else {
                    console.log('Audio controls already exist');
                }
            })
        );

        // Wait for layout to be ready before setting up file listeners
        this.app.workspace.onLayoutReady(() => {
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

            console.log('[Sidekick] File change listeners registered');

            // Schedule embedding updates after layout is ready
            this.scheduleEmbeddingUpdates();
        });
    }

    private async initializeEmbeddings() {
        // Get all files that need processing
        const files = this.app.vault.getMarkdownFiles();
        console.log(`Found ${files.length} markdown files to check`);

        // Check both embedding and date indices
        const [embeddingResults, dateResults] = await Promise.all([
            this.getFilesToProcess(files),
            this.getFilesToProcessDates(files)
        ]);

        // Process embeddings if needed
        if (embeddingResults.length > 0) {
            console.log(`[Sidekick] Found ${embeddingResults.length} files that need embedding updates`);
            await this.processFiles(embeddingResults);
        }

        // Process date indexing if needed
        if (dateResults.length > 0) {
            console.log(`[Sidekick] Found ${dateResults.length} files that need date indexing`);
            for (const file of dateResults) {
                await this.dateIndex.indexNote(file);
            }
        }
    }

    private async getFilesToProcessDates(files: TFile[]): Promise<TFile[]> {
        // Filter out files from excluded folders first
        const filteredFiles = files.filter(file => {
            const isExcluded = this.settings.excludedFolders.some(folder => 
                file.path.startsWith(folder)
            );
            return !isExcluded;
        });

        // Get all currently indexed files
        const indexedFiles = await this.dateIndex.getAllIndexed();
        const indexMap = new Map(indexedFiles.map(f => [f.id, f]));

        // Find files that need processing
        const filesToProcess: TFile[] = [];
        for (const file of filteredFiles) {
            const needsIndexing = await this.dateIndex.needsIndexing(file);
            if (needsIndexing) {
                filesToProcess.push(file);
            }
        }

        return filesToProcess;
    }

    async onunload() {
        console.log('Unloading ObsidianChatSidebar plugin');
        // Properly clean up views
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_CHAT_SIDEBAR);
        
        if (this.embeddingInterval) {
            clearInterval(this.embeddingInterval);
        }
        this.audioControls.unload();
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        
        console.log('Loading settings, encrypted key exists:', !!this.settings.encryptedApiKey);
        
        if (this.settings.encryptedApiKey?.trim()) {
            try {
                console.log('Attempting to decrypt key...');
                const decryptedKey = await EncryptionHelper.decrypt(this.settings.encryptedApiKey);
                console.log('Key decrypted successfully:', !!decryptedKey);
                this.settings.openAIApiKey = decryptedKey;
            } catch (error) {
                console.error('Failed to decrypt API key:', error);
                new Notice('Failed to load API key. Please re-enter it in settings.');
                this.settings.openAIApiKey = '';
                this.settings.encryptedApiKey = '';
            }
        }
    }

    async saveSettings() {
        try {
            if (this.settings.openAIApiKey?.trim()) {
                console.log('Encrypting API key...');
                const encryptedKey = await EncryptionHelper.encrypt(this.settings.openAIApiKey);
                console.log('Key encrypted successfully:', !!encryptedKey);
                
                await this.saveData({
                    ...this.settings,
                    encryptedApiKey: encryptedKey,
                    openAIApiKey: '' // Don't store unencrypted key
                });
                console.log('Settings saved with encrypted key');
            } else {
                // If no API key, remove both encrypted and unencrypted versions
                const { openAIApiKey, encryptedApiKey, ...otherSettings } = this.settings;
                await this.saveData(otherSettings);
            }
        } catch (error) {
            console.error('Failed to save API key:', error);
            new Notice('Failed to save API key securely. Please try again.');
            throw error;
        }
    }

    async startEmbeddingProcess() {
        if (this.isIndexing) {
            console.log('Already indexing, returning early');
            return;
        }

        console.log('\n=== SIDEKICK START EMBEDDING PROCESS ===');
        this.isIndexing = true;
        this.stopIndexing = false;

        // Get all markdown files and current embeddings
        const files = this.app.vault.getMarkdownFiles();
        console.log(`Found ${files.length} markdown files before processing`);
        const embeddings = await getAllEmbeddings();

        // Clean up orphaned embeddings
        for (const embedding of embeddings) {
            const fileExists = files.some(file => file.path === embedding.id);
            if (!fileExists) {
                console.log(`Cleaning up orphaned embedding for ${embedding.id}`);
                await deleteEmbedding(embedding.id);
            }
        }

        console.log('About to call getFilesToProcess...');
        // Get files that need processing
        const filesToProcess = await this.getFilesToProcess(files);
        
        if (!this.settings.openAIApiKey) {
            new Notice('Please set your OpenAI API key in settings first.');
            return;
        }

        console.log(`Found ${filesToProcess.length} total markdown files (after exclusions)`);

        const existingEmbeddings = await getAllEmbeddings();
        console.log(`Found ${existingEmbeddings.length} existing embeddings`);
        
        const embeddingMap = new Map(existingEmbeddings.map(e => [e.id, e]));
        
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
            console.log('[Sidekick] Indexing in progress, queueing change for:', file.path);
            this.pendingFileChanges.add(file.path);
            return;
        }

        // Add to pending changes
        this.pendingFileChanges.add(file.path);

        // Clear existing timeout if it exists
        if (this.fileChangeTimeout) {
            clearTimeout(this.fileChangeTimeout);
        }

        // Set new timeout to process changes
        this.fileChangeTimeout = setTimeout(async () => {
            console.log(`[Sidekick] Processing ${this.pendingFileChanges.size} pending file changes`);
            
            // Only process if we have changes and aren't already indexing
            if (this.pendingFileChanges.size > 0 && !this.isIndexing) {
                this.isIndexing = true;
                try {
                    // Get all files that need processing
                    const pendingFiles = this.app.vault.getMarkdownFiles()
                        .filter(f => this.pendingFileChanges.has(f.path));
                    
                    // Check both indices
                    const [embeddingResults, dateResults] = await Promise.all([
                        this.getFilesToProcess(pendingFiles),
                        this.getFilesToProcessDates(pendingFiles)
                    ]);
                    
                    // Process embeddings if needed
                    if (embeddingResults.length > 0) {
                        await this.processFiles(embeddingResults);
                    }

                    // Process date indexing if needed
                    if (dateResults.length > 0) {
                        for (const file of dateResults) {
                            await this.dateIndex.indexNote(file);
                        }
                    }
                } catch (error) {
                    console.error('[Sidekick] Error processing file changes:', error);
                } finally {
                    this.isIndexing = false;
                    this.pendingFileChanges.clear();
                }
            }
        }, 5000); // Wait 5 seconds for batching
    }

    private async processFiles(files: TFile[]) {
        if (!this.settings.openAIApiKey) {
            console.log('[Sidekick] No API key set, skipping processing');
            return;
        }

        console.log(`[Sidekick] Processing ${files.length} files`);
        for (const file of files) {
            try {
                const content = await this.app.vault.read(file);
                const embedding = await generateEmbedding(content, this.settings.openAIApiKey);
                await saveEmbedding({ 
                    id: file.path, 
                    embedding,
                    lastModified: file.stat.mtime 
                });
                console.log(`[Sidekick] Successfully processed: ${file.path}`);
                
                // Add a small delay between files to avoid rate limits
                await new Promise(resolve => setTimeout(resolve, 1000)); // Increased delay to 1 second
            } catch (error) {
                console.error(`[Sidekick] Error processing ${file.path}:`, error);
                // Continue with next file if there's an error
            }
        }
    }

    scheduleEmbeddingUpdates() {
        const intervalMinutes = this.settings.embeddingUpdateInterval;
        const intervalMs = intervalMinutes * 60 * 1000;

        console.log(`Scheduling embedding updates every ${intervalMinutes} minutes`);
        this.embeddingInterval = setInterval(() => {
            console.log('\n=== SIDEKICK SCHEDULED UPDATE TRIGGERED ===');
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

    private async getFilesToProcess(files: TFile[]): Promise<TFile[]> {
        console.log('\n=== SIDEKICK EMBEDDING CHECK STARTED ===');
        console.log('Debug file input:');
        console.log('- Input files array length:', files.length);
        console.log('- Direct vault check:', this.app.vault.getMarkdownFiles().length);
        console.log('- Sample of first file (if exists):', files[0]?.path);
        
        console.log(`Total files found: ${files.length}`);
        
        // Filter out files from excluded folders
        const filteredFiles = files.filter(file => {
            const isExcluded = this.settings.excludedFolders.some(folder => 
                file.path.startsWith(folder)
            );
            if (isExcluded) {
                console.debug(`🚫 Excluded: ${file.path}`);
            }
            return !isExcluded;
        });

        console.log(`\n📁 Files after exclusion: ${filteredFiles.length}`);
        if (this.settings.excludedFolders.length > 0) {
            console.log(`📂 Excluded folders: ${this.settings.excludedFolders.join(', ')}`);
        }

        // Get existing embeddings
        const existingEmbeddings = await getAllEmbeddings();
        const embeddingMap = new Map(existingEmbeddings.map(e => [e.id, e]));
        console.log(`💾 Existing embeddings: ${existingEmbeddings.length}`);

        // Debug: Log path comparison for first few files
        console.log('\n🔍 Path Comparison Debug:');
        console.log('First 3 files in vault:');
        files.slice(0, 3).forEach(file => {
            console.log(`  File path: "${file.path}"`);
            const embedding = embeddingMap.get(file.path);
            console.log(`  Has embedding? ${!!embedding}`);
            if (embedding) {
                console.log(`  Stored ID: "${embedding.id}"`);
                console.log(`  Paths match? ${file.path === embedding.id}`);
                console.log(`  Modified time: ${file.stat.mtime}`);
                console.log(`  Embedding time: ${embedding.lastModified}`);
            }
            console.log('');
        });

        console.log('First 3 embeddings in storage:');
        existingEmbeddings.slice(0, 3).forEach(emb => {
            console.log(`  Stored ID: "${emb.id}"`);
            const file = files.find(f => f.path === emb.id);
            console.log(`  Found matching file? ${!!file}`);
            if (file) {
                console.log(`  File path: "${file.path}"`);
                console.log(`  Modified time: ${file.stat.mtime}`);
                console.log(`  Embedding time: ${emb.lastModified}`);
            }
            console.log('');
        });

        // Filter files that need processing (new or modified)
        const newFiles: string[] = [];
        const modifiedFiles: string[] = [];
        
        const filesToProcess = filteredFiles.filter(file => {
            const existing = embeddingMap.get(file.path);
            
            // If no existing embedding, it's a new file
            if (!existing) {
                newFiles.push(file.path);
                return true;
            }

            // Compare timestamps - normalize to seconds to avoid millisecond differences
            const fileTimestamp = Math.floor(file.stat.mtime / 1000);
            const embeddingTimestamp = Math.floor((existing.lastModified || 0) / 1000);
            const needsProcessing = fileTimestamp > embeddingTimestamp;
            
            if (needsProcessing) {
                const modifiedTime = new Date(file.stat.mtime).toISOString();
                const lastEmbedTime = new Date(existing.lastModified || 0).toISOString();
                modifiedFiles.push(
                    `${file.path}\n    modified: ${modifiedTime} (${file.stat.mtime})\n    embedded: ${lastEmbedTime} (${existing.lastModified})`
                );
            }
            
            return needsProcessing;
        });

        // Print summary
        console.log('\n=== EMBEDDING CHECK SUMMARY ===');
        console.log(`🆕 New files to process: ${newFiles.length}`);
        if (newFiles.length > 0) {
            console.log('New files:');
            newFiles.forEach(file => console.log(`  - ${file}`));
        }
        
        console.log(`\n📝 Modified files to process: ${modifiedFiles.length}`);
        if (modifiedFiles.length > 0) {
            console.log('Modified files:');
            modifiedFiles.forEach(file => console.log(`  - ${file}`));
        }
        
        console.log('\n=== EMBEDDING CHECK COMPLETED ===\n');
        return filesToProcess;
    }

    private async testDateIndex() {
        console.log('\n=== TESTING DATE INDEX ===');
        
        try {
            // 1. First rebuild the index
            console.log('Building date index...');
            await this.dateIndex.rebuildIndex();
            
            // 2. Get all markdown files for testing
            const files = this.app.vault.getMarkdownFiles();
            console.log(`Total files in vault: ${files.length}`);

            // Debug: Print first 3 files
            console.log('\nFirst 3 files in vault:');
            files.slice(0, 3).forEach(file => {
                console.log(`- ${file.path} (modified: ${new Date(file.stat.mtime).toLocaleString()})`);
            });

            // 3. Test today's files
            console.log('\nTesting today filter:');
            const todayFiles = await this.dateIndex.filterByDate(files, { relative: 'today' });
            console.log(`Files from today: ${todayFiles.length}`);
            todayFiles.slice(0, 3).forEach(file => {
                console.log(`- ${file.path} (modified: ${new Date(file.stat.mtime).toLocaleString()})`);
            });

            // 4. Test this month's files
            console.log('\nTesting this month filter:');
            const thisMonthFiles = await this.dateIndex.filterByDate(files, { relative: 'this_month' });
            console.log(`Files from this month: ${thisMonthFiles.length}`);
            thisMonthFiles.slice(0, 3).forEach(file => {
                console.log(`- ${file.path} (modified: ${new Date(file.stat.mtime).toLocaleString()})`);
            });

            // 5. Test a specific date range
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);
            console.log('\nTesting last 30 days filter:');
            const rangeFiles = await this.dateIndex.filterByDate(files, {
                start: lastMonth,
                end: new Date()
            });
            console.log(`Files from last 30 days: ${rangeFiles.length}`);
            rangeFiles.slice(0, 3).forEach(file => {
                console.log(`- ${file.path} (modified: ${new Date(file.stat.mtime).toLocaleString()})`);
            });

            // 6. Test metadata for a specific file
            if (files.length > 0) {
                const testFile = files[0];
                console.log('\nTesting metadata extraction for:', testFile.path);
                const metadata = await this.dateIndex.getMetadata(testFile.path);
                console.log('Metadata:', {
                    created: metadata ? new Date(metadata.createdAt).toLocaleString() : 'N/A',
                    modified: metadata ? new Date(metadata.modifiedAt).toLocaleString() : 'N/A',
                    contentDates: metadata ? metadata.contentDates.map(d => new Date(d).toLocaleString()) : []
                });
            }

            console.log('\n=== DATE INDEX TEST COMPLETE ===\n');
        } catch (error) {
            console.error('Error testing date index:', error);
        }
    }
}
