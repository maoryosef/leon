import type { WsEvent } from '@leon/shared';

type Listener = (event: WsEvent) => void;

/**
 * Typed pub/sub for WsEvents. The daemon subscribes once and fans out to
 * connected WebSocket clients; core services publish domain changes here.
 */
export class EventBus {
  private listeners = new Set<Listener>();

  emit(event: WsEvent): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        // a broken subscriber must never take down the publisher
      }
    }
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
