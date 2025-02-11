export class DateService {
    /**
     * Gets the current date and time in ISO format
     * @returns {string} Current date and time in ISO format
     */
    static getCurrentDate(): string {
        const now = new Date();
        return now.toISOString();
    }

    /**
     * Gets the current date in a human-readable format
     * @returns {string} Current date in format "MMMM DD, YYYY"
     */
    static getCurrentDateHumanReadable(): string {
        const now = new Date();
        return now.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }
}

// Test the service when the file is loaded
console.log('DateService loaded. Current date:', DateService.getCurrentDateHumanReadable()); 