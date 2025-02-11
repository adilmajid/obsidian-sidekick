import { App, PluginSettingTab, Setting, TextAreaComponent, SuggestModal, TFile, Modal, Notice } from 'obsidian';
import localforage from 'localforage';
import ObsidianChatSidebar from './main';
import { ChatSidebarSettings } from './settings';
import { getAllEmbeddings } from './storageService';
import { AVAILABLE_MODELS, AVAILABLE_VOICES } from './settings';

export class ChatSidebarSettingTab extends PluginSettingTab {
    plugin: ObsidianChatSidebar;
    private personalInfoTextArea: TextAreaComponent;

    constructor(app: App, plugin: ObsidianChatSidebar) {
        super(app, plugin);
        this.plugin = plugin;
    }

    async display(): Promise<void> {
        const { containerEl } = this;
        containerEl.empty();
        // User context section
        containerEl.createEl('h3', { text: 'Personal settings' });

        new Setting(containerEl)
            .setName('About you')
            .setDesc('Share information about yourself that Sidekick should know. Use [[ to link to your notes.')
            .addTextArea(text => {
                this.personalInfoTextArea = text;
                text
                    .setPlaceholder('Enter any details you want Sidekick to know...')
                    .setValue(this.plugin.settings.personalInfo)
                    .onChange(async (value) => {
                        this.plugin.settings.personalInfo = value;
                        await this.plugin.saveSettings();
                    });
                
                // Add note linking functionality
                text.inputEl.addEventListener('keydown', async (event: KeyboardEvent) => {
                    const textArea = text.inputEl;
                    const cursorPosition = textArea.selectionStart;
                    const textBeforeCursor = textArea.value.substring(0, cursorPosition);
                    
                    if (event.key === '[' && 
                        textBeforeCursor.endsWith('[') && 
                        !textBeforeCursor.endsWith(']]')) {
                        
                        event.preventDefault();
                        
                        // Show file suggester
                        const files = this.app.vault.getMarkdownFiles();
                        const modal = new FileSuggestModal(
                            this.app,
                            files,
                            async (file) => {
                                const link = `[[${file.path}]]`;
                                const beforeLink = textArea.value.substring(0, cursorPosition - 1);
                                const afterLink = textArea.value.substring(cursorPosition);
                                const newValue = beforeLink + link + afterLink;
                                
                                textArea.value = newValue;
                                this.plugin.settings.personalInfo = newValue;
                                await this.plugin.saveSettings();
                                
                                // Set cursor position after the link
                                const newPosition = beforeLink.length + link.length;
                                textArea.setSelectionRange(newPosition, newPosition);
                                textArea.focus();
                            }
                        );
                        modal.open();
                    }
                });
                
                return text;
            })
            .setClass('personal-info-setting');
    
        new Setting(containerEl)
            .setName('Suggested prompts')
            .setDesc('Add suggested prompts (one per line). Three will be chosen at random to be displayed in new conversations.')
            .addTextArea(text => text
                .setPlaceholder('Enter prompts, one per line')
                .setValue(this.plugin.settings.suggestedPrompts.join('\n'))
                .onChange(async (value) => {
                    this.plugin.settings.suggestedPrompts = value
                        .split('\n')
                        .map(prompt => prompt.trim())
                        .filter(prompt => prompt.length > 0);
                    await this.plugin.saveSettings();
                }))
            .setClass('suggested-prompts-setting');

        // AI Prompts and Context section
        containerEl.createEl('h3', { text: 'Sidekick configuration' });

        new Setting(containerEl)
            .setName('System prompt')
            .setDesc('Customize how Sidekick behaves and responds.')
            .addTextArea(text => text
                .setValue(this.plugin.settings.systemPrompt)
                .onChange(async (value) => {
                    this.plugin.settings.systemPrompt = value;
                    await this.plugin.saveSettings();
                }))
            .setClass("system-prompt-setting");

        new Setting(containerEl)
            .setName('Sidekick memory')
            .setDesc('Information Sidekick remembers about you and your notes. Sidekick can update this during conversations.')
            .addTextArea(text => text
                .setPlaceholder('Sidekick memory contents...')
                .setValue(this.plugin.settings.memory)
                .onChange(async (value) => {
                    this.plugin.settings.memory = value;
                    await this.plugin.saveSettings();
                }))
            .setClass('memory-setting');

        // Model Configuration section
        containerEl.createEl('h3', { text: 'Chat Model settings' });
        
        new Setting(containerEl)
            .setName('OpenAI model')
            .setDesc('Select which model to use for chat responses.')
            .addDropdown(dropdown => {
                AVAILABLE_MODELS.forEach(model => {
                    dropdown.addOption(model.value, model.label);
                });
                return dropdown
                    .setValue(this.plugin.settings.model)
                    .onChange(async (value) => {
                        this.plugin.settings.model = value;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName('OpenAI API key')
            .setDesc('Enter your OpenAI API key.')
            .addText(text => text
                .setPlaceholder('Enter your API key')
                .setValue(this.plugin.settings.openAIApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.openAIApiKey = value.trim();
                    await this.plugin.saveSettings();
                })
                .inputEl.addClass('chat-sidebar-settings-elevenlabs-api-key'));

        // ElevenLabs settings
        containerEl.createEl('h3', { text: 'Voice Model settings' });
        new Setting(containerEl)
            .setName('ElevenLabs API key')
            .setDesc('Enter your ElevenLabs API key for text-to-speech functionality.')
            .addText(text => text
                .setPlaceholder('Enter your ElevenLabs API key')
                .setValue(this.plugin.settings.elevenLabsApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.elevenLabsApiKey = value.trim();
                    await this.plugin.saveSettings();
                })
                .inputEl.addClass('chat-sidebar-settings-elevenlabs-api-key'));

        // Add voice selection dropdown
        new Setting(containerEl)
            .setName('ElevenLabs voice')
            .setDesc('Select which voice to use for text-to-speech.')
            .addDropdown(dropdown => {
                AVAILABLE_VOICES.forEach(voice => {
                    dropdown.addOption(voice.value, voice.label);
                });
                return dropdown
                    .setValue(this.plugin.settings.elevenLabsVoice)
                    .onChange(async (value) => {
                        this.plugin.settings.elevenLabsVoice = value;
                        await this.plugin.saveSettings();
                    });
            });

        // Embedding Configuration section
        containerEl.createEl('h3', { text: 'Embedding settings' });

        const embeddings = await getAllEmbeddings();
        const markdownFiles = this.app.vault.getMarkdownFiles();
        const totalNotes = markdownFiles.length;
        
        // Only count embeddings that correspond to existing files
        const validEmbeddings = embeddings.filter(embedding => 
            markdownFiles.some(file => file.path === embedding.id)
        );

        new Setting(containerEl)
            .setName('Indexing status')
            .setDesc(`${validEmbeddings.length} of ${totalNotes} notes indexed`)
            .addButton(button => {
                if (this.plugin.isIndexing) {
                    button
                        .setButtonText('Stop Indexing')
                        .setClass('mod-warning')
                        .onClick(() => {
                            this.plugin.stopEmbedding();
                        });
                } else if (validEmbeddings.length < totalNotes) {
                    button
                        .setButtonText('Index un-indexed notes')
                        .onClick(() => {
                            this.plugin.startEmbeddingProcess();
                        });
                } else {
                    button.setButtonText('All notes indexed').setDisabled(true);
                }
            });

        new Setting(containerEl)
            .setName('Embedding update interval')
            .setDesc('Set how often embeddings are updated (in minutes).')
            .addText(text => text
                .setPlaceholder('e.g., 60')
                .setValue(String(this.plugin.settings.embeddingUpdateInterval))
                .onChange(async (value) => {
                    const parsed = parseInt(value);
                    if (!isNaN(parsed)) {
                        this.plugin.settings.embeddingUpdateInterval = parsed;
                        await this.plugin.saveSettings();
                    }
                }));

        new Setting(containerEl)
            .setName('Excluded folders')
            .setDesc('Folders to exclude from indexing (one per line)')
            .addTextArea(text => {
                text
                    .setPlaceholder('folder1/\nfolder2/')
                    .setValue(this.plugin.settings.excludedFolders.join('\n'))
                    .onChange(async (value) => {
                        this.plugin.settings.excludedFolders = value
                            .split('\n')
                            .map(folder => folder.trim())
                            .filter(folder => folder.length > 0);
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.cols = 25;
            })
            .setClass('excluded-folders-setting');

        new Setting(containerEl)
            .setName('Delete all indices')
            .setDesc('Delete all stored embeddings and date indices. Use this if you want to start fresh or free up space.')
            .addButton(button => button
                .setButtonText('Delete all indices')
                .setWarning()
                .onClick(async () => {
                    const confirmed = await new Promise(resolve => {
                        const modal = new Modal(this.app);
                        modal.titleEl.setText('Confirm Deletion');
                        modal.contentEl.setText('Are you sure you want to delete all embeddings and date indices? This cannot be undone.');
                        
                        modal.contentEl.createDiv('modal-button-container', (div: HTMLDivElement) => {
                            div.createEl('button', { text: 'Cancel' })
                                .onclick = () => {
                                    modal.close();
                                    resolve(false);
                                };
                            div.createEl('button', { 
                                cls: 'mod-warning', 
                                text: 'Delete' 
                            }).onclick = () => {
                                modal.close();
                                resolve(true);
                            };
                        });
                        
                        modal.open();
                    });

                    if (confirmed) {
                        // Configure localforage to use embeddings store before clearing
                        localforage.config({
                            name: 'ObsidianChatSidebar',
                            storeName: 'embeddings'
                        });
                        await localforage.clear();
                        new Notice('All indices have been deleted');
                        
                        // Ask user if they want to rebuild indices now
                        const rebuildNow = await new Promise(resolve => {
                            const modal = new Modal(this.app);
                            modal.titleEl.setText('Rebuild Indices?');
                            modal.contentEl.setText('Would you like to rebuild the indices now? This may take a while depending on the size of your vault.');
                            
                            modal.contentEl.createDiv('modal-button-container', (div: HTMLDivElement) => {
                                div.createEl('button', { text: 'Later' })
                                    .onclick = () => {
                                        modal.close();
                                        resolve(false);
                                    };
                                div.createEl('button', { 
                                    cls: 'mod-cta', 
                                    text: 'Rebuild Now' 
                                }).onclick = () => {
                                    modal.close();
                                    resolve(true);
                                };
                            });
                            
                            modal.open();
                        });

                        if (rebuildNow) {
                            // Start with date index as it's usually faster
                            new Notice('Building date index...');
                            await this.plugin.dateIndex.rebuildIndex();
                            new Notice('Date index rebuilt. Starting embedding process...');
                            
                            // Then start the embedding process
                            this.plugin.startEmbeddingProcess();
                        } else {
                            new Notice('You can rebuild indices later from the settings tab');
                        }
                        
                        this.display(); // Refresh the settings view
                    }
                }));

    }
}

// Add FileSuggestModal class
class FileSuggestModal extends SuggestModal<TFile> {
    constructor(
        app: App,
        private files: TFile[],
        private onChoose: (file: TFile) => void
    ) {
        super(app);
    }

    getSuggestions(query: string): TFile[] {
        return this.files.filter(file => 
            file.path.toLowerCase().includes(query.toLowerCase())
        );
    }

    renderSuggestion(file: TFile, el: HTMLElement) {
        el.createEl("div", { text: file.path });
    }

    onChooseSuggestion(file: TFile, evt: MouseEvent | KeyboardEvent) {
        this.onChoose(file);
    }
}