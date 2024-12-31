import { App, PluginSettingTab, Setting, TextAreaComponent, SuggestModal, TFile, Modal, Notice } from 'obsidian';
import localforage from 'localforage';
import ObsidianChatSidebar from './main';
import { ChatSidebarSettings } from './settings';
import { getAllEmbeddings } from './storageService';
import { AVAILABLE_MODELS } from './settings';

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
        containerEl.createEl('h2', { text: 'Sidekick settings' });

        // AI Prompts and Context section
        containerEl.createEl('h3', { text: 'Prompts and Context' });

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
        containerEl.createEl('h3', { text: 'Model settings' });
        
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
                .inputEl.addClass('chat-sidebar-settings-api-key'));

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
            .setName('Delete all embeddings')
            .setDesc('Delete all stored embeddings. Use this if you want to start fresh or free up space.')
            .addButton(button => button
                .setButtonText('Delete all embeddings')
                .setWarning()
                .onClick(async () => {
                    const confirmed = await new Promise(resolve => {
                        const modal = new Modal(this.app);
                        modal.titleEl.setText('Confirm Deletion');
                        modal.contentEl.setText('Are you sure you want to delete all embeddings? This cannot be undone.');
                        
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
                        await localforage.clear();
                        new Notice('All embeddings have been deleted');
                        this.display(); // Refresh the settings view
                    }
                }));

        new Setting(containerEl)
            .setName('Suggested prompts')
            .setDesc('Add prompts to suggest to users (one per line)')
            .addTextArea(text => {
                text
                    .setPlaceholder('Enter prompts, one per line')
                    .setValue(this.plugin.settings.suggestedPrompts.join('\n'))
                    .onChange(async (value) => {
                        this.plugin.settings.suggestedPrompts = value
                            .split('\n')
                            .map(prompt => prompt.trim())
                            .filter(prompt => prompt.length > 0);
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 6;
                text.inputEl.cols = 50;
            })
            .setClass('suggested-prompts-setting');
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