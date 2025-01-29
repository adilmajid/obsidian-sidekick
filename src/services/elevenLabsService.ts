export class ElevenLabsService {
    private apiKey: string;
    private audioElement: HTMLAudioElement | null = null;
    private controller: AbortController | null = null;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
    }

    async textToSpeech(text: string, voiceId: string): Promise<Blob> {
        // Clean up aliased wiki-links, keeping regular wiki-links intact
        const cleanedText = text.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2');

        const requestBody = {
            text: cleanedText,  // Use cleaned text instead of original
            model_id: 'eleven_monolingual_v1',
            voice_settings: {
                stability: 0.5,
                similarity_boost: 0.5
            }
        };

        console.log('ElevenLabs API Request:', {
            endpoint: `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
            voiceId: voiceId,
            requestBody: requestBody,
            textLength: cleanedText.length,
            textPreview: cleanedText.slice(0, 500) + (cleanedText.length > 500 ? '...' : '')
        });

        const response = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
            method: 'POST',
            headers: {
                'Accept': 'audio/mpeg',
                'Content-Type': 'application/json',
                'xi-api-key': this.apiKey
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            console.error('ElevenLabs API error:', await response.text());
            throw new Error(`ElevenLabs API error: ${response.statusText}`);
        }

        return await response.blob();
    }

    playAudio(audioBlob: Blob) {
        if (this.audioElement) {
            this.stopAudio();
        }

        const url = URL.createObjectURL(audioBlob);
        this.audioElement = new Audio(url);
        this.audioElement.play();
    }

    pauseAudio() {
        this.audioElement?.pause();
    }

    resumeAudio() {
        this.audioElement?.play();
    }

    stopAudio() {
        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.currentTime = 0;
            URL.revokeObjectURL(this.audioElement.src);
            this.audioElement = null;
        }
    }

    seek(seconds: number) {
        if (this.audioElement) {
            this.audioElement.currentTime += seconds;
        }
    }

    isPlaying(): boolean {
        return this.audioElement !== null && !this.audioElement.paused;
    }
} 