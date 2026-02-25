/**
 * @fileoverview JSON 基础类型定义
 * @description 定义 Record-Replay V3 中使用的 JSON 相关类型
 */

/** JSON 原始类型 */
export type JsonPrimitive = string | number | boolean | null;

/** JSON 对象类型 */
export interface JsonObject {
  [key: string]: JsonValue;
}

/** JSON 数组类型 */
export type JsonArray = JsonValue[];

/** 任意 JSON 值类型 */
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** ISO 8601 日期时间字符串 */
export type ISODateTimeString = string;

/** Unix 毫秒时间戳 */
export type UnixMillis = number;
