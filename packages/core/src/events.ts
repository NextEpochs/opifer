/**
 * Bus di eventi in processo. Nella v1 gli eventi vengono anche persistiti e
 * consegnati via WebSocket e webhook; qui c'è solo la forma comune.
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
        // un ascoltatore difettoso non deve fermare gli altri
      }
    }
    return event;
  }
}
