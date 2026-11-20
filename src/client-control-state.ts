/**
 * 客户端中间件：Host store（会话模型目录 / 配置表单 / 写入协调器）与上下文控件之间的
 * 归一化控制状态层。
 *
 * 控件不再直接解读 Host 目录的原始 status（'ready' / 'loading' / 'selecting' …）。
 * 后台目录刷新（status 离开 ready 但当前模型仍在、无待切换）不是不可用：缓存容量行与
 * 表单仍然可用，控件保持可点。只有真正的待切换、目录错误、表单未就绪/只读、在途保存
 * 或缺少容量参考才阻塞。设置页与聊天胶囊共用同一套“何时可编辑”的判定来源。
 *
 * 纯函数 + 一个订阅聚合 hook；不含网络 I/O、不写配置。
 */
import * as React from 'react';
import type { ConfigForm, FormSnapshot, FormValues } from './client.js';
import type { ConfigWrites, ConfigWriteSnapshot } from './client-config-writes.js';
import type { QuickDirectorySnapshot, QuickDirectoryStore } from './client-context-quick.js';
import type { ModelSettings, ModelSettingsMap } from './model-settings.js';
import type { StatusModel } from './remote.js';

export interface QuickControlInputs {
  directory: QuickDirectorySnapshot;
  form: FormSnapshot;
  /** 表单值与在途写入投影合并后的值。 */
  values: FormValues;
  pendingFields: readonly string[];
  modelId: string;
  row: StatusModel | undefined;
  awaiting: boolean;
}

export interface QuickControlState {
  /** 非 undefined 表示控件被阻塞，并给出就近说明。 */
  reason: string | undefined;
  pending: boolean;
  settings: ModelSettings;
  settingsMap: ModelSettingsMap;
}

/** 由 Host store 快照推导控件状态；后台刷新不阻塞，只有真实不可用才阻塞。 */
export function quickControlState(input: QuickControlInputs): QuickControlState {
  const { directory, form, values, pendingFields, modelId, row, awaiting } = input;
  const pending = pendingFields.includes('modelSettings');
  const settingsMap = values.modelSettings ?? {};
  const settings = settingsMap[modelId] ?? {};
  const selecting = directory.pending !== null;
  const directoryError = directory.status === 'error';
  const reason = selecting ? '正在切换模型，请稍候。'
    : directoryError ? '会话模型目录读取失败，请稍后重试。'
      : form.status === 'unavailable' ? '模型设置暂不可用。'
        : form.status !== 'ready' || form.value === undefined ? '正在载入模型设置。'
          : !form.writable ? '当前设置为只读。'
            : pending ? '正在保存模型设置…'
              : row === undefined ? (awaiting ? '正在读取模型参考容量…' : '当前模型不在 CoRouter 目录中。') : undefined;
  return { reason, pending, settings, settingsMap };
}

export interface QuickStores {
  snapshot: QuickDirectorySnapshot;
  formState: FormSnapshot;
  writeState: ConfigWriteSnapshot;
}

/** 聚合三个 Host store 的订阅；组件只消费归一化后的状态，不各自解读原始快照。 */
export function useQuickStores(directory: QuickDirectoryStore, form: ConfigForm, writes: ConfigWrites): QuickStores {
  const snapshot = React.useSyncExternalStore(
    React.useCallback(listener => directory.subscribe(listener), [directory]),
    React.useCallback(() => directory.getSnapshot(), [directory]),
    React.useCallback(() => directory.getSnapshot(), [directory]),
  );
  const formState = React.useSyncExternalStore(
    React.useCallback(listener => form.subscribe(listener), [form]),
    React.useCallback(() => form.getSnapshot(), [form]),
    React.useCallback(() => form.getSnapshot(), [form]),
  );
  const writeState = React.useSyncExternalStore(
    React.useCallback(listener => writes.subscribe(listener), [writes]),
    React.useCallback(() => writes.getSnapshot(), [writes]),
    React.useCallback(() => writes.getSnapshot(), [writes]),
  );
  return { snapshot, formState, writeState };
}
