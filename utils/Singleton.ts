// 抽象单例基类
abstract class Singleton {
  private static instances = new Map<Function, any>();

  protected constructor() {}

  public static getInstance<T extends Singleton>(this: new () => T): T {
    if (!Singleton.instances.has(this)) {
      Singleton.instances.set(this, new this());
    }
    return Singleton.instances.get(this) as T;
  }
}

export default Singleton;
