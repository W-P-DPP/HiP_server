import Singleton from "./Singleton.ts";

class EventEmitter extends Singleton {
  private events: Record<string, Function[]> = {};

  protected constructor() {
    super();
  }

  // 订阅事件
  public on(event: string, listener: Function) {
    if (!this.events[event]) this.events[event] = [];
    this.events[event].push(listener);
  }

  // 订阅一次
  public once(event: string, listener: Function) {
    const onceListener = (...args: any[]) => {
      try {
        listener(...args);
      } finally {
        this.off(event, onceListener);
      }
    };
    this.on(event, onceListener);
  }

  // 发布事件
  public emit(event: string, ...args: any[]) {
    const handlers = this.events[event];
    if (!handlers || handlers.length === 0) return;
    handlers.slice().forEach((h) => {
      try {
        h(...args);
      } catch (e) {
        console.error(`Error in handler for ${event}:`, e);
      }
    });
  }

  // 移除事件监听器
  public off(event: string, listenerToRemove: Function) {
    const handlers = this.events[event];
    if (!handlers) return;
    this.events[event] = handlers.filter((h) => h !== listenerToRemove);
  }

  clear() {
    this.events = {};
  }
}

export default (EventEmitter as any).getInstance();
