const ENCRYPTION_KEY = 'sidekick-for-obsidian-alpha';

export class EncryptionHelper {
    private static async getKey(secret: string = ENCRYPTION_KEY): Promise<CryptoKey> {
        const encoder = new TextEncoder();
        const keyMaterial = await window.crypto.subtle.importKey(
            'raw',
            encoder.encode(secret),
            { name: 'PBKDF2' },
            false,
            ['deriveBits', 'deriveKey']
        );

        return window.crypto.subtle.deriveKey(
            {
                name: 'PBKDF2',
                salt: encoder.encode('sidekick-salt'),
                iterations: 100000,
                hash: 'SHA-256'
            },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            true,
            ['encrypt', 'decrypt']
        );
    }

    static async encrypt(text: string): Promise<string> {
        const encoder = new TextEncoder();
        const key = await this.getKey();
        
        // Generate random IV
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        
        const encryptedData = await window.crypto.subtle.encrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            key,
            encoder.encode(text)
        );

        // Combine IV and encrypted data
        const combined = new Uint8Array(iv.length + new Uint8Array(encryptedData).length);
        combined.set(iv);
        combined.set(new Uint8Array(encryptedData), iv.length);

        // Convert to base64 for storage
        return btoa(String.fromCharCode(...combined));
    }

    static async decrypt(encryptedText: string): Promise<string> {
        const decoder = new TextDecoder();
        const key = await this.getKey();
        
        // Convert from base64 and separate IV and data
        const combined = new Uint8Array(
            atob(encryptedText).split('').map(char => char.charCodeAt(0))
        );
        
        const iv = combined.slice(0, 12);
        const data = combined.slice(12);

        const decryptedData = await window.crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: iv
            },
            key,
            data
        );

        return decoder.decode(decryptedData);
    }
} 