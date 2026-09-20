/**
 * In-process event bus. In v1 the events are also persisted and delivered
 * via WebSocket and webhooks; here there is only the common shape.
 */

export interface DomainEvent<T = unknown> {
  type: string;
  companyId: string | null;
  occurredAt: string;
  payload: T;
}

export type EventListener = (event: DomainEvent) => void;

export class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish<T>(type: string, companyId: string | null, payload: T): DomainEvent<T> {
    const event: DomainEvent<T> = { type, companyId, occurredAt: new Date().toISOString(), payload };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a faulty listener must not stop the others
      }
    }
    return event;
  }
}
