/**
 * Host 侧中间件：插件状态与 Host 模型选择器之间的唯一发布通道。
 *
 * 此前目录每次发布、以及任何 volatile 配置写入，都直接调用 `registration.replace()`，
 * 于是 Host 为每个会话重建模型目录，聊天上下文控件随之变灰刷新——保存档位本身也会触发。
 * 这里把“何时通知选择器”收敛为一个中间件：它只对**选择器真正可见的投影**
 * （`listModels` 暴露的 id / group / name / enabled / inputModalities）做差异比较，
 * 投影不变则不通知；温度、Top P、输出、上下文档位、思考、协议、额度与监控字段的写入
 * 都不改变该投影，因此不会扰动选择器。
 *
 * 通知是同步的：目录发布依赖 `changed()` 同步抛错来回滚（选择器更新失败保留旧目录），
 * 延迟到微任务会让该异常逃逸，故不做异步合并。
 */

export interface SelectorBridgeOptions {
  /** 当前选择器可见投影的稳定序列化；只包含 listModels 暴露的字段。 */
  projection(): string;
  /** 原子替换已注册路由；仅当投影变化时被调用，抛错由调用方（目录）回滚处理。 */
  replace(): void;
}

export class SelectorBridge {
  private advertised: string;
  private disposed = false;
  constructor(private readonly options: SelectorBridgeOptions) {
    this.advertised = options.projection();
  }
  /** 请求一次发布检查；投影未变或已销毁时为无操作。 */
  notify(): void {
    if (this.disposed) return;
    const next = this.options.projection();
    if (next === this.advertised) return;
    const previous = this.advertised;
    this.advertised = next;
    try {
      this.options.replace();
    } catch (error) {
      // The selector kept its old routes; stay in sync so a retry is possible and the
      // directory's synchronous rollback sees the same advertised state as the Host.
      this.advertised = previous;
      throw error;
    }
  }
  dispose(): void {
    this.disposed = true;
  }
}
