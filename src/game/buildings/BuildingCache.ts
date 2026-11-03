export class BuildingCache<T> {
  private map = new Map<string, T>();
  private order: string[] = [];

  constructor(private max = 5000) {}

  get(key: string) {
    return this.map.get(key);
  }

  set(key: string, value: T) {
    if (!this.map.has(key)) {
      this.order.push(key);
      if (this.order.length > this.max) {
        const old = this.order.shift();
        if (old) this.map.delete(old);
      }
    }
    this.map.set(key, value);
  }

  clear() {
    this.map.clear();
    this.order.length = 0;
  }
}
