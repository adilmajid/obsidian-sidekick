import { App, Menu, MenuItem, setIcon } from 'obsidian';
import { ChatThread } from './types';
import OpenAI from 'openai';

export class ThreadHistoryDropdown {
    constructor(
        private app: App,
        private threads: ChatThread[],
        private onSelect: (threadId: string) => void,
        private onDelete: (threadId: string) => void,
        private onDeleteAll: () => void,
        private openai: OpenAI,
        private position: { x: number, y: number }
    ) {}

    async show() {
        try {
            const menu = new Menu();

            // Add thread items
            const sortedThreads = [...this.threads]
                .sort((a, b) => b.lastModified - a.lastModified);

            for (const thread of sortedThreads) {
                if (thread.messages.length === 0) continue;

                menu.addItem((item: MenuItem) => {
                    const itemEl = (item as any).titleEl as HTMLElement;
                    const container = itemEl.createDiv({ cls: 'thread-item-container' });
                    
                    const titleEl = container.createDiv({ 
                        cls: 'thread-item-title',
                        text: (thread.title || 'Untitled Chat') + ' '
                    });
                    
                    const dateEl = container.createDiv({ 
                        cls: 'thread-item-date',
                        text: window.moment(thread.lastModified).format('MMM D, YYYY h:mm A')
                    });

                    // Ensure elements are appended in the correct order
                    container.appendChild(titleEl);
                    container.appendChild(dateEl);

                    const deleteButton = container.createEl('button', {
                        cls: 'thread-item-delete',
                        attr: { 'aria-label': 'Delete Thread' }
                    });
                    setIcon(deleteButton, 'trash-2');
                    
                    deleteButton.addEventListener('click', (e: MouseEvent) => {
                        e.stopPropagation();
                        this.onDelete(thread.id);
                        menu.close();
                    });

                    item.onClick(() => {
                        this.onSelect(thread.id);
                        menu.close();
                    });
                });
            }

            menu.showAtPosition(this.position);
        } catch (error) {
            console.error('Error showing menu:', error);
        }
    }
} 