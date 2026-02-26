/**
 * @fileoverview JSON Basic type definition
 * @description Define JSON related types used in Record-Replay V3
 */

/** JSON primitive type */
export type JsonPrimitive = string | number | boolean | null;

/** JSON Object type */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** JSON array type */
export type JsonArray = JsonValue[];

/** Any JSON value type */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** ISO 8601 datetime string */
export type ISODateTimeString = string;

/** Unix millisecond timestamp */
export type UnixMillis = number;
