/**
 * @fileoverview 变量类型定义
 * @description 定义 Record-Replay V3 中使用的变量指针和持久化变量
 */

import type { JsonValue, UnixMillis } from './json';

/** 变量名称 */
export type VariableName = string;

/** 持久化变量名称（以 $ 开头） */
export type PersistentVariableName = `$${string}`;

/** 变量作用域 */
export type VariableScope = 'run' | 'flow' | 'persistent';

/**
 * 变量指针
 * @description 指向变量的引用，支持 JSON path 访问
 */
export interface VariablePointer {
  /** 变量作用域 */
  scope: VariableScope;
  /** 变量名称 */
  name: VariableName;
  /** JSON path（用于访问嵌套属性） */
  path?: ReadonlyArray<string | number>;
}

/**
 * 变量定义
 * @description Flow 中声明的变量
 */
export interface VariableDefinition {
  /** 变量名称 */
  name: VariableName;
  /** 显示标签 */
  label?: string;
  /** 描述 */
  description?: string;
  /** 是否敏感（不显示/导出） */
  sensitive?: boolean;
  /** 是否必需 */
  required?: boolean;
  /** 默认值 */
  default?: JsonValue;
  /** 作用域（不含 persistent，persistent 通过 $ 前缀判断） */
  scope?: Exclude<VariableScope, 'persistent'>;
}

/**
 * 持久化变量记录
 * @description 存储在 IndexedDB 中的持久化变量
 */
export interface PersistentVarRecord {
  /** 变量键（以 $ 开头） */
  key: PersistentVariableName;
  /** 变量值 */
  value: JsonValue;
  /** 最后更新时间 */
  updatedAt: UnixMillis;
  /** 版本号（单调递增，用于 LWW 和调试） */
  version: number;
}

/**
 * 判断变量名是否为持久化变量
 */
export function isPersistentVariable(name: string): name is PersistentVariableName {
  return name.startsWith('$');
}

/**
 * 解析变量指针字符串
 * @example "$user.name" -> { scope: 'persistent', name: '$user', path: ['name'] }
 */
export function parseVariablePointer(ref: string): VariablePointer | null {
  if (!ref) return null;

  const parts = ref.split('.');
  const name = parts[0];
  const path = parts.slice(1);

  if (isPersistentVariable(name)) {
    return {
      scope: 'persistent',
      name,
      path: path.length > 0 ? path : undefined,
    };
  }

  // 默认为 run 作用域
  return {
    scope: 'run',
    name,
    path: path.length > 0 ? path : undefined,
  };
}
