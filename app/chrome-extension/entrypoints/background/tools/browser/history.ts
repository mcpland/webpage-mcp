import { createErrorResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES } from 'webpage-mcp-shared';
import { hasDisallowedPublicUrlScheme } from './common';
import {
  measureJsonBytes,
  measureUtf8Bytes,
  normalizeBoundedInteger,
  truncateJsonString,
} from './bounded-tool-output';
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
  truncated?: true;
}

export const HISTORY_MAX_RESULTS = 500;
export const HISTORY_MAX_QUERY_UTF8_BYTES = 4 * 1024;
export const HISTORY_MAX_TIME_INPUT_UTF8_BYTES = 128;
export const HISTORY_MAX_OUTPUT_UTF8_BYTES = 1024 * 1024;
const HISTORY_MAX_ID_JSON_BYTES = 512;
const HISTORY_MAX_URL_JSON_BYTES = 8 * 1024;
const HISTORY_MAX_TITLE_JSON_BYTES = 4 * 1024;
const HISTORY_MAX_OPEN_TABS_SCAN = 2_000;
const HISTORY_OUTPUT_ENVELOPE_RESERVE_BYTES = 4 * 1024;
const HISTORY_MAX_RELATIVE_AMOUNT = 10_000;

function isPublicHistoryUrl(url?: string | null): url is string {
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
      if (!Number.isSafeInteger(amount) || amount > HISTORY_MAX_RELATIVE_AMOUNT) {
        return null;
      }
      const unit = relativeMatch[2];
      let resultDate: Date;
      if (unit.startsWith('day')) resultDate = subDays(now, amount);
      else if (unit.startsWith('week')) resultDate = subWeeks(now, amount);
      else if (unit.startsWith('month')) resultDate = subMonths(now, amount);
      else if (unit.startsWith('year')) resultDate = subYears(now, amount);
      else return null; // Should not happen with the regex
      return isValid(resultDate) ? resultDate.getTime() : null;
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
      const text = typeof args.text === 'string' ? args.text : '';
      if (
        measureUtf8Bytes(text, HISTORY_MAX_QUERY_UTF8_BYTES) >
        HISTORY_MAX_QUERY_UTF8_BYTES
      ) {
        return createErrorResponse(
          `History query exceeds the ${HISTORY_MAX_QUERY_UTF8_BYTES}-byte limit.`,
        );
      }
      for (const [field, value] of [
        ['startTime', args.startTime],
        ['endTime', args.endTime],
      ] as const) {
        if (
          value !== undefined &&
          (typeof value !== 'string' ||
            measureUtf8Bytes(value, HISTORY_MAX_TIME_INPUT_UTF8_BYTES) >
              HISTORY_MAX_TIME_INPUT_UTF8_BYTES)
        ) {
          return createErrorResponse(
            `${field} must be a string no larger than ${HISTORY_MAX_TIME_INPUT_UTF8_BYTES} UTF-8 bytes.`,
          );
        }
      }

      const maxResults = normalizeBoundedInteger(
        args.maxResults,
        100,
        1,
        HISTORY_MAX_RESULTS,
      );
      const excludeCurrentTabs = args.excludeCurrentTabs === true;

      const now = Date.now();
      let startTimeMs: number;
      let endTimeMs: number;

      // Parse startTime
      if (args.startTime) {
        const parsedStart = this.parseDateString(args.startTime);
        if (parsedStart === null) {
          return createErrorResponse(
            'Invalid start time. Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".',
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
            'Invalid end time. Supported formats: ISO (YYYY-MM-DD), "today", "yesterday", "X days/weeks/months/years ago".',
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

      const openUrls = new Set<string>();
      if (excludeCurrentTabs && historyItems.length > 0) {
        const currentTabs = await chrome.tabs.query({});
        const tabScanLimit = Math.min(currentTabs.length, HISTORY_MAX_OPEN_TABS_SCAN);
        for (let index = 0; index < tabScanLimit; index += 1) {
          const tab = currentTabs[index];
          const { url } = tab;
          if (isPublicHistoryUrl(url)) {
            openUrls.add(url);
          }
        }
      }

      const items: HistoryItem[] = [];
      let itemBytes = 2;
      let truncated = historyItems.length >= maxResults;
      const scanLimit = Math.min(historyItems.length, maxResults);
      for (let index = 0; index < scanLimit; index += 1) {
        const item = historyItems[index];
        if (!isPublicHistoryUrl(item.url) || openUrls.has(item.url)) continue;
        const boundedItem: HistoryItem = {
          id: truncateJsonString(item.id, HISTORY_MAX_ID_JSON_BYTES),
          url: truncateJsonString(item.url, HISTORY_MAX_URL_JSON_BYTES),
          title: truncateJsonString(item.title, HISTORY_MAX_TITLE_JSON_BYTES),
          lastVisitTime:
            typeof item.lastVisitTime === 'number' && Number.isFinite(item.lastVisitTime)
              ? item.lastVisitTime
              : undefined,
          visitCount:
            typeof item.visitCount === 'number' && Number.isFinite(item.visitCount)
              ? item.visitCount
              : undefined,
          typedCount:
            typeof item.typedCount === 'number' && Number.isFinite(item.typedCount)
              ? item.typedCount
              : undefined,
        };
        const nextBytes = measureJsonBytes(boundedItem) + (items.length > 0 ? 1 : 0);
        if (
          itemBytes + nextBytes >
          HISTORY_MAX_OUTPUT_UTF8_BYTES - HISTORY_OUTPUT_ENVELOPE_RESERVE_BYTES
        ) {
          truncated = true;
          break;
        }
        items.push(boundedItem);
        itemBytes += nextBytes;
      }

      const result: HistoryResult = {
        items,
        totalCount: items.length,
        timeRange: {
          startTime: startTimeMs,
          endTime: endTimeMs,
          startTimeFormatted: this.formatDate(startTimeMs),
          endTimeFormatted: this.formatDate(endTimeMs),
        },
      };

      if (text) {
        result.query = truncateJsonString(text, HISTORY_MAX_QUERY_UTF8_BYTES);
      }
      if (truncated) result.truncated = true;

      let serialized = JSON.stringify(result);
      while (
        measureUtf8Bytes(serialized, HISTORY_MAX_OUTPUT_UTF8_BYTES) >
          HISTORY_MAX_OUTPUT_UTF8_BYTES &&
        result.items.length > 0
      ) {
        result.items.pop();
        result.totalCount = result.items.length;
        result.truncated = true;
        serialized = JSON.stringify(result);
      }

      return {
        content: [
          {
            type: 'text',
            text: serialized,
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
