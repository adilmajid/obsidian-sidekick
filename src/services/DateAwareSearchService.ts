import { TFile, Vault, MetadataCache } from 'obsidian';
import { SearchService, SearchResult } from './SearchService';
import { DateIndex, DateFilter } from './DateIndex';
import OpenAI from 'openai';

interface DateQuery {
    type: 'absolute' | 'relative' | 'comparison';
    filter?: DateFilter;
    dateRanges?: {
        start: Date;
        end: Date;
    }[];
    comparisonPeriods?: {
        period1: { start: Date; end: Date };
        period2: { start: Date; end: Date };
    };
}

export interface DateAwareSearchResult extends SearchResult {
    dateRelevance?: {
        matchType: 'creation' | 'modification' | 'content' | null;
        date: number;
    };
}

export class DateAwareSearchService {
    private openai: OpenAI;

    constructor(
        private searchService: SearchService,
        private dateIndex: DateIndex,
        private vault: Vault,
        private metadataCache: MetadataCache,
        apiKey: string
    ) {
        this.openai = new OpenAI({
            apiKey: apiKey,
            dangerouslyAllowBrowser: true
        });
    }

    /**
     * Main search method that combines semantic and date-based search
     */
    async search(query: string): Promise<DateAwareSearchResult[]> {
        // First, analyze the query for date-related aspects
        const dateQuery = await this.analyzeDateQuery(query);
        
        // Get semantic search results
        const semanticResults = await this.searchService.search(query);
        
        // If no date aspects in query, return semantic results as is
        if (!dateQuery) {
            return semanticResults as DateAwareSearchResult[];
        }

        // Get date-filtered results
        const dateResults = await this.getDateFilteredResults(dateQuery);
        
        // Merge and rank results
        return this.mergeAndRankResults(semanticResults, dateResults, dateQuery);
    }

    /**
     * Analyze query to detect and parse date-related aspects
     */
    private async analyzeDateQuery(query: string): Promise<DateQuery | null> {
        try {
            const response = await this.openai.chat.completions.create({
                model: "gpt-4-0125-preview",
                messages: [
                    {
                        role: "system",
                        content: `Analyze the query for date-related aspects. Respond in JSON format with the following structure:
                        {
                            "hasDateAspect": boolean,
                            "type": "absolute" | "relative" | "comparison",
                            "filter": {
                                "relative"?: "today" | "this_week" | "this_month" | "this_year",
                                "start"?: "YYYY-MM-DD",
                                "end"?: "YYYY-MM-DD"
                            },
                            "comparisonPeriods"?: {
                                "period1": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
                                "period2": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" }
                            }
                        }
                        
                        Examples:
                        "what did I learn today" -> { "hasDateAspect": true, "type": "relative", "filter": { "relative": "today" } }
                        "my notes from January 2020" -> { "hasDateAspect": true, "type": "absolute", "filter": { "start": "2020-01-01", "end": "2020-01-31" } }
                        "how did my journal in 2018 differ from 2022" -> { "hasDateAspect": true, "type": "comparison", "comparisonPeriods": { "period1": { "start": "2018-01-01", "end": "2018-12-31" }, "period2": { "start": "2022-01-01", "end": "2022-12-31" } } }
                        "what is the meaning of life" -> { "hasDateAspect": false }`
                    },
                    {
                        role: "user",
                        content: query
                    }
                ],
                temperature: 0.1,
            });

            const analysis = JSON.parse(response.choices[0].message.content!);
            
            if (!analysis.hasDateAspect) {
                return null;
            }

            // Convert string dates to Date objects
            const dateQuery: DateQuery = {
                type: analysis.type
            };

            if (analysis.filter) {
                dateQuery.filter = {
                    relative: analysis.filter.relative,
                    start: analysis.filter.start ? new Date(analysis.filter.start) : undefined,
                    end: analysis.filter.end ? new Date(analysis.filter.end) : undefined
                };
            }

            if (analysis.comparisonPeriods) {
                dateQuery.comparisonPeriods = {
                    period1: {
                        start: new Date(analysis.comparisonPeriods.period1.start),
                        end: new Date(analysis.comparisonPeriods.period1.end)
                    },
                    period2: {
                        start: new Date(analysis.comparisonPeriods.period2.start),
                        end: new Date(analysis.comparisonPeriods.period2.end)
                    }
                };
            }

            return dateQuery;
        } catch (error) {
            console.error('Error analyzing date query:', error);
            return null;
        }
    }

    /**
     * Get results filtered by date criteria
     */
    private async getDateFilteredResults(dateQuery: DateQuery): Promise<DateAwareSearchResult[]> {
        const results: DateAwareSearchResult[] = [];
        const files = this.vault.getMarkdownFiles();

        if (dateQuery.type === 'comparison') {
            // For comparisons, we need to get results from both periods
            const period1Files = await this.dateIndex.filterByDate(files, {
                start: dateQuery.comparisonPeriods!.period1.start,
                end: dateQuery.comparisonPeriods!.period1.end
            });
            
            const period2Files = await this.dateIndex.filterByDate(files, {
                start: dateQuery.comparisonPeriods!.period2.start,
                end: dateQuery.comparisonPeriods!.period2.end
            });

            // Add results from both periods
            await this.addDateAwareResults(results, period1Files);
            await this.addDateAwareResults(results, period2Files);
        } else {
            // For regular queries, just get files from the specified period
            const filteredFiles = await this.dateIndex.filterByDate(files, dateQuery.filter!);
            await this.addDateAwareResults(results, filteredFiles);
        }

        return results;
    }

    /**
     * Helper method to add date-aware results
     */
    private async addDateAwareResults(results: DateAwareSearchResult[], files: TFile[]) {
        for (const file of files) {
            const metadata = await this.dateIndex.getMetadata(file.path);
            if (!metadata) continue;

            const content = await this.vault.read(file);
            results.push({
                id: file.path,
                score: 1.0, // We'll adjust this when merging with semantic results
                content: content.slice(0, 500), // Get first 500 chars as preview
                fullContent: content,
                dateRelevance: {
                    matchType: 'creation',
                    date: metadata.createdAt
                }
            });
        }
    }

    /**
     * Merge and rank results from both semantic and date-based searches
     */
    private mergeAndRankResults(
        semanticResults: SearchResult[],
        dateResults: DateAwareSearchResult[],
        dateQuery: DateQuery
    ): DateAwareSearchResult[] {
        const mergedResults = new Map<string, DateAwareSearchResult>();

        // Add semantic results first
        for (const result of semanticResults) {
            mergedResults.set(result.id, {
                ...result,
                score: result.score
            });
        }

        // Merge date results
        for (const result of dateResults) {
            if (mergedResults.has(result.id)) {
                // If we already have this result from semantic search,
                // boost its score based on date relevance
                const existing = mergedResults.get(result.id)!;
                existing.score = Math.max(existing.score, result.score) * 1.2; // 20% boost for date relevance
                existing.dateRelevance = result.dateRelevance;
            } else {
                // If it's a new result, add it
                mergedResults.set(result.id, result);
            }
        }

        // Convert map back to array and sort by score
        return Array.from(mergedResults.values())
            .sort((a, b) => b.score - a.score);
    }
} 