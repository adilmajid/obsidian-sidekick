import { TFile, Vault } from 'obsidian';
import localforage from 'localforage';

interface DateMetadata {
    id: string;               // File path
    createdAt: number;        // Unix timestamp
    modifiedAt: number;       // Unix timestamp
    contentDates: number[];   // Array of Unix timestamps found in content
    lastIndexed: number;      // When we last indexed this file
}

export interface DateFilter {
    start?: Date;
    end?: Date;
    relative?: 'today' | 'this_week' | 'this_month' | 'this_year';
}

// Create a dedicated store for date indexing
const dateStore = localforage.createInstance({
    name: 'ObsidianChatSidebar',
    storeName: 'date_index',
    description: 'Store for note date metadata'
});

export class DateIndex {
    private vault: Vault;

    constructor(vault: Vault) {
        this.vault = vault;
    }

    /**
     * Index a single note's date metadata
     */
    async indexNote(file: TFile): Promise<void> {
        const content = await this.vault.read(file);
        const metadata = await this.extractDateMetadata(file, content);
        metadata.lastIndexed = Date.now();  // Add lastIndexed timestamp
        await dateStore.setItem(file.path, metadata);
    }

    /**
     * Extract all date-related metadata from a note
     */
    private async extractDateMetadata(file: TFile, content: string): Promise<DateMetadata> {
        // Extract dates from content using regex
        const contentDates = this.extractDatesFromContent(content);

        return {
            id: file.path,
            createdAt: file.stat.ctime,
            modifiedAt: file.stat.mtime,
            contentDates: contentDates,
            lastIndexed: Date.now()  // Set initial lastIndexed to current time
        };
    }

    /**
     * Extract dates mentioned in content using regex
     */
    private extractDatesFromContent(content: string): number[] {
        const dates = new Set<number>();
        
        // Common date formats
        const datePatterns = [
            // ISO format: 2024-01-31
            /\b\d{4}-\d{2}-\d{2}\b/g,
            // US format: 01/31/2024 or 01-31-2024
            /\b\d{2}[/-]\d{2}[/-]\d{4}\b/g,
            // Written format: January 31, 2024 or Jan 31, 2024
            /\b(?:January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},?\s+\d{4}\b/g
        ];

        for (const pattern of datePatterns) {
            const matches = content.matchAll(pattern);
            for (const match of matches) {
                try {
                    const date = new Date(match[0]);
                    if (!isNaN(date.getTime())) {
                        dates.add(date.getTime());
                    }
                } catch (e) {
                    console.debug('Failed to parse date:', match[0]);
                }
            }
        }

        return Array.from(dates);
    }

    /**
     * Get metadata for a specific note
     */
    async getMetadata(filePath: string): Promise<DateMetadata | null> {
        return await dateStore.getItem(filePath);
    }

    /**
     * Filter files based on a date range
     */
    async filterByDate(files: TFile[], filter: DateFilter): Promise<TFile[]> {
        let startTime = filter.start?.getTime() || 0;
        let endTime = filter.end?.getTime() || Date.now();

        // If using relative dates, calculate the range
        if (filter.relative) {
            const { start, end } = this.getRelativeDateRange(filter.relative);
            startTime = start.getTime();
            endTime = end.getTime();
        }

        const results: TFile[] = [];

        for (const file of files) {
            const metadata = await this.getMetadata(file.path);
            if (!metadata) continue;

            // Check if file's dates fall within range
            if (this.isInDateRange(metadata, startTime, endTime)) {
                results.push(file);
            }
        }

        return results;
    }

    /**
     * Check if a file's dates fall within a range
     */
    private isInDateRange(metadata: DateMetadata, startTime: number, endTime: number): boolean {
        // Check creation date
        if (metadata.createdAt >= startTime && metadata.createdAt <= endTime) {
            return true;
        }

        // Check modification date
        if (metadata.modifiedAt >= startTime && metadata.modifiedAt <= endTime) {
            return true;
        }

        // Check content dates
        for (const date of metadata.contentDates) {
            if (date >= startTime && date <= endTime) {
                return true;
            }
        }

        return false;
    }

    /**
     * Calculate date range for relative filters
     */
    private getRelativeDateRange(relative: string): { start: Date; end: Date } {
        const now = new Date();
        const start = new Date(now);
        const end = new Date(now);

        switch (relative) {
            case 'today':
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                break;
            case 'this_week':
                start.setDate(now.getDate() - now.getDay()); // Start of week (Sunday)
                end.setDate(start.getDate() + 6); // End of week (Saturday)
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                break;
            case 'this_month':
                start.setDate(1); // Start of month
                end.setMonth(start.getMonth() + 1, 0); // End of month
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                break;
            case 'this_year':
                start.setMonth(0, 1); // Start of year
                end.setMonth(11, 31); // End of year
                start.setHours(0, 0, 0, 0);
                end.setHours(23, 59, 59, 999);
                break;
        }

        return { start, end };
    }

    /**
     * Rebuild the entire index
     */
    async rebuildIndex(): Promise<void> {
        console.log('Starting index rebuild...');
        
        // Clear existing index
        await dateStore.clear();
        console.log('Cleared existing index');

        // Get all markdown files
        const files = this.vault.getMarkdownFiles();
        console.log(`Found ${files.length} files to index`);

        // Index each file
        let indexed = 0;
        for (const file of files) {
            try {
                await this.indexNote(file);
                indexed++;
                if (indexed % 10 === 0) {
                    console.log(`Indexed ${indexed}/${files.length} files`);
                }
            } catch (error) {
                console.error(`Error indexing ${file.path}:`, error);
            }
        }

        console.log(`Completed indexing ${indexed} files`);
    }

    /**
     * Delete a note from the index
     */
    async deleteNote(filePath: string): Promise<void> {
        await dateStore.removeItem(filePath);
    }

    /**
     * Get all indexed files
     */
    async getAllIndexed(): Promise<DateMetadata[]> {
        const keys = await dateStore.keys();
        const items: DateMetadata[] = [];
        for (const key of keys) {
            const item = await dateStore.getItem(key);
            if (this.isDateMetadata(item)) {
                items.push(item);
            }
        }
        return items;
    }

    /**
     * Type guard to check if an unknown value is a DateMetadata object
     */
    private isDateMetadata(value: unknown): value is DateMetadata {
        return (
            typeof value === 'object' &&
            value !== null &&
            'id' in value &&
            'createdAt' in value &&
            'modifiedAt' in value &&
            'contentDates' in value &&
            'lastIndexed' in value &&
            Array.isArray((value as DateMetadata).contentDates)
        );
    }

    /**
     * Check if a file needs indexing based on its modification time
     */
    async needsIndexing(file: TFile): Promise<boolean> {
        const metadata = await this.getMetadata(file.path);
        if (!metadata) return true;  // Not indexed yet
        
        // Compare timestamps - normalize to seconds to avoid millisecond differences
        const fileTimestamp = Math.floor(file.stat.mtime / 1000);
        const indexTimestamp = Math.floor(metadata.lastIndexed / 1000);
        return fileTimestamp > indexTimestamp;
    }
} 