import type { PaperOrder } from '@nemesis/core';

export class PaperOrderBook {
  private orders: PaperOrder[] = [];

  add(order: PaperOrder) {
    this.orders.push(order);
  }

  working(): PaperOrder[] {
    return this.orders.filter((o) => o.status === 'working');
  }

  cancel(id: string): boolean {
    const o = this.orders.find((x) => x.id === id);
    if (!o || o.status !== 'working') return false;
    o.status = 'cancelled';
    return true;
  }

  cancelAll(): number {
    let cancelled = 0;
    for (const order of this.orders) {
      if (order.status !== 'working') continue;
      order.status = 'cancelled';
      cancelled += 1;
    }
    return cancelled;
  }

  fill(id: string) {
    const o = this.orders.find((x) => x.id === id);
    if (o) o.status = 'filled';
  }

  load(orders: PaperOrder[]) {
    this.orders = orders;
  }

  snapshot(): PaperOrder[] {
    return JSON.parse(JSON.stringify(this.orders));
  }
}
