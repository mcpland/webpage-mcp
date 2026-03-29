import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { hasDisallowedPublicUrlScheme } from './common';
import {
  parseISO,
  subDays,
  subWeeks,
  subMonths,
  subYears,
  startOfToday,
  startOfYesterday,
  isValid,
  format,
} from 'date-fns';

interface HistoryToolParams {
  text?: string;
  startTime?: string;
  endTime?: string;
  maxResults?: number;
  excludeCurrentTabs?: boolean;
}

interface HistoryItem {
  id: string;
  url?: string;
  title?: string;
  lastVisitTime?: number; // Timestamp in milliseconds
  visitCount?: number;
  typedCount?: number;
}

interface HistoryResult {
  items: HistoryItem[];
  totalCount: number;
  timeRange: {
    startTime: number;
    endTime: number;
    startTimeFormatted: string;
    endTimeFormatted: string;
  };
  query?: string;
}

function isPublicHistoryUrl(url?: string | null): boolean {
  return typeof url === 'string' && url.trim().length > 0 && !hasDisallowedPublicUrlScheme(url);
}

class HistoryTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.HISTORY;
  private static readonly ONE_DAY_MS = 24 * 60 * 60 * 1000;

  /**
   * Parse a date string into milliseconds since epoch.
   * Returns null if the date string is invalid.
   * Supports:
   *  - ISO date strings (e.g., "2023-10-31", "2023-10-31T14:30:00.000Z")
   *  - Relative times: "1 day ago", "2 weeks ago", "3 months ago", "1 year ago"
   *  - Special keywords: "now", "today", "yesterday"
   */
  private parseDateString(dateStr: string | undefined | null): number | null {
    if (!dateStr) {
      // If an empty or null string is passed, it might mean "no specific date",
      // depending on how you want to treat it. Returning null is safer.
      return null;
    }

    const now = new Date();
    const lowerDateStr = dateStr.toLowerCase().trim();

    if (lowerDateStr === 'now') return now.getTime();
    if (lowerDateStr === 'today') return startOfToday().getTime();
    if (lowerDateStr === 'yesterday') return startOfYesterday().getTime();

    const relativeMatch = lowerDateStr.match(
      /^(\d+)\s+(day|days|week|weeks|month|months|year|years)\s+ago$/,
    );
    if (relativeMatch) {
      const amount = parseInt(relativeMatch[1], 10);
      const unit = relativeMatch[2];
      let resultDate: Date;
      if (unit.startsWith('day')) resultDate = subDays(now, amount);
      else if (unit.startsWith('week')) resultDate = subWeeks(now, amount);
      else if (unit.startsWith('month')) resultDate = subMonths(now, amount);
      else if (unit.startsWith('year')) resultDate = subYears(now, amount);
      else return null; // Should not happen with the regex
      return resultDate.getTime();
    }

    // Try parsing as ISO or other common date string formats
    // Native Date constructor can be unreliable for non-standard formats.
    // date-fns' parseISO is good for ISO 8601.
    // For other formats, date-fns' parse function is more flexible.
    let parsedDate = parseISO(dateStr); // Handles "2023-10-31" or "2023-10-31T10:00:00"
    if (isValid(parsedDate)) {
      return parsedDate.getTime();
    }

    // Fallback to new Date() for other potential formats, but with caution
    parsedDate = new Date(dateStr);
    if (isValid(parsedDate) && dateStr.includes(parsedDate.getFullYear().toString())) {
      return parsedDate.getTime();
    }

    console.warn(`Could not parse date string: ${dateStr}`);
    return null;
  }

  /**
   * Format a timestamp as a human-readable date string
   */
  private formatDate(timestamp: number): string {
    // Using date-fns for consistent and potentially localized formatting
    return format(timestamp, 'yyyy-MM-dd HH:mm:ss');
  }

  async execute(args: HistoryToolParams): Promise<ToolResult> {
    try {
      console.log('Executing HistoryTool with args:', args);

      const {
        text = '',
        maxResults = 100, // Default to 100 results
        excludeCurrentTabs = false,
      } = args;

      const now = Date.now();
      let startTimeMs: number;
      let endTimeMs: number;

      // Parse startTime
      if (args.startTime) {
        const parsedStart = this.parseDateString(args.startTime);
        if (parsedStart === null) {
          return createErrorResponse(
            `Invalid format for start time: "${args.startTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
          );
        }
        startTimeMs = parsedStart;
      } else {
        // Default to 24 hours ago if startTime is not provided
        startTimeMs = now - HistoryTool.ONE_DAY_MS;
      }

      // Parse endTime
      if (args.endTime) {
        const parsedEnd = this.parseDateString(args.endTime);
        if (parsedEnd === null) {
          return createErrorResponse(
            `Invalid format for end time: "${args.endTime}". Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".`,
          );
        }
        endTimeMs = parsedEnd;
      } else {
        // Default to current time if endTime is not provided
        endTimeMs = now;
      }

      // Validate time range
      if (startTimeMs > endTimeMs) {
        return createErrorResponse('Start time cannot be after end time.');
      }

      console.log(
        `Searching history from ${this.formatDate(startTimeMs)} to ${this.formatDate(endTimeMs)} for query "${text}"`,
      );

      const historyItems = await chrome.history.search({
        text,
        startTime: startTimeMs,
        endTime: endTimeMs,
        maxResults,
      });

      console.log(`Found ${historyItems.length} history items before filtering current tabs.`);

      let filteredItems = historyItems.filter((item) => isPublicHistoryUrl(item.url));
      if (excludeCurrentTabs && historyItems.length > 0) {
        const currentTabs = await chrome.tabs.query({});
        const openUrls = new Set<string>();

        currentTabs.forEach((tab) => {
          if (isPublicHistoryUrl(tab.url)) {
            openUrls.add(tab.url);
          }
        });

        if (openUrls.size > 0) {
          filteredItems = filteredItems.filter((item) => !(item.url && openUrls.has(item.url)));
          console.log(
            `Filtered out ${historyItems.length - filteredItems.length} items that are currently open. ${filteredItems.length} items remaining.`,
          );
        }
      }

      const result: HistoryResult = {
        items: filteredItems.map((item) => ({
          id: item.id,
          url: item.url,
          title: item.title,
          lastVisitTime: item.lastVisitTime,
          visitCount: item.visitCount,
          typedCount: item.typedCount,
        })),
        totalCount: filteredItems.length,
        timeRange: {
          startTime: startTimeMs,
          endTime: endTimeMs,
          startTimeFormatted: this.formatDate(startTimeMs),
          endTimeFormatted: this.formatDate(endTimeMs),
        },
      };

      if (text) {
        result.query = text;
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(result, null, 2),
          },
        ],
        isError: false,
      };
    } catch (error) {
      console.error('Error in HistoryTool.execute:', error);
      return createErrorResponse(
        `Error retrieving browsing history: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export const historyTool = new HistoryTool();
