import { App, Component, TFile, Notice } from 'obsidian';
import { ElevenLabsService } from '../services/elevenLabsService';
import { ChatSidebarSettings } from '../settings';

export class AudioControls extends Component {
    public containerEl: HTMLElement;
    private elevenLabs: ElevenLabsService;
    private currentFile: TFile | null = null;
    private audioBlob: Blob | null = null;
    private playButton: HTMLElement;
    private playbackControls: HTMLElement;
    protected app: App;

    constructor(
        app: App,
        parentEl: HTMLElement, 
        private settings: ChatSidebarSettings
    ) {
        super();
        this.app = app;
        this.containerEl = parentEl.createDiv('audio-controls');
        this.containerEl.addClass('audio-controls-container');
        this.elevenLabs = new ElevenLabsService(settings.elevenLabsApiKey);
        this.initializeUI();
    }

    private initializeUI() {
        // Initial play button
        this.playButton = this.containerEl.createEl('button', {
            cls: 'audio-control-button clickable-icon view-action',
            attr: { 'aria-label': 'Play note' }
        });
        
        // Hide play button if no API key
        if (!this.settings.elevenLabsApiKey) {
            this.playButton.style.display = 'none';
        }

        this.playButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
        
        // Hidden controls (shown when playing)
        this.playbackControls = this.containerEl.createDiv('playback-controls');
        this.playbackControls.style.display = 'none';

        const rewindButton = this.createControlButton(this.playbackControls, 'Rewind 10s', `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 2v6h6M2.66 15.57a10 10 0 1 0 .57-8.38"/></svg>`);
        const pauseButton = this.createControlButton(this.playbackControls, 'Pause', `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`);
        const forwardButton = this.createControlButton(this.playbackControls, 'Forward 10s', `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38"/></svg>`);
        const stopButton = this.createControlButton(this.playbackControls, 'Stop', `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>`);

        // Event handlers
        this.playButton.onclick = async () => {
            if (!this.currentFile) return;
            
            // Hide play button and show loading spinner
            this.playButton.style.display = 'none';
            
            // Create loading spinner with stop functionality
            const loadingContainer = this.containerEl.createEl('button', {
                cls: 'audio-control-button clickable-icon view-action',
                attr: { 'aria-label': 'Loading audio... Click to cancel' }
            });
            
            // Add spinner icon
            loadingContainer.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
            
            // Add hover effect to show stop icon
            loadingContainer.onmouseenter = () => {
                loadingContainer.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/></svg>`;
            };
            
            loadingContainer.onmouseleave = () => {
                loadingContainer.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
            };

            try {
                const content = await this.app.vault.read(this.currentFile);
                
                // Allow cancellation
                loadingContainer.onclick = () => {
                    loadingContainer.remove();
                    this.playButton.style.display = 'block';
                    throw new Error('Audio generation cancelled');
                };
                
                this.audioBlob = await this.elevenLabs.textToSpeech(content, this.settings.elevenLabsVoice);
                
                // Remove loading spinner and show controls
                loadingContainer.remove();
                this.playbackControls.style.display = 'flex';
                this.elevenLabs.playAudio(this.audioBlob);
            } catch (error) {
                if (error.message !== 'Audio generation cancelled') {
                    // Show error state
                    new Notice('Failed to generate audio');
                    loadingContainer.remove();
                    this.playButton.style.display = 'block';
                }
            }
        };

        rewindButton.onclick = () => this.elevenLabs.seek(-10);
        forwardButton.onclick = () => this.elevenLabs.seek(10);
        pauseButton.onclick = () => {
            if (this.elevenLabs.isPlaying()) {
                this.elevenLabs.pauseAudio();
                pauseButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
            } else {
                this.elevenLabs.resumeAudio();
                pauseButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
            }
        };

        stopButton.onclick = () => {
            this.elevenLabs.stopAudio();
            this.playbackControls.style.display = 'none';
            this.playButton.style.display = 'block';
        };
    }

    private createControlButton(container: HTMLElement, ariaLabel: string, svg: string): HTMLElement {
        const button = container.createEl('button', {
            cls: 'audio-control-button clickable-icon view-action',
            attr: { 'aria-label': ariaLabel }
        });
        button.innerHTML = svg;
        return button;
    }

    updateFile(file: TFile | null) {
        this.currentFile = file;
        this.elevenLabs.stopAudio();
        this.playbackControls.style.display = 'none';
        
        // Only show play button if we have both a file and an API key
        if (file && this.settings.elevenLabsApiKey) {
            this.playButton.style.display = 'block';
        } else {
            this.playButton.style.display = 'none';
        }
    }
} 