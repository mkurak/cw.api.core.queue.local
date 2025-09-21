export interface QueueOptions {
    /**
     * Milliseconds allowed for a consumer to acknowledge a message before it is re-queued.
     * Provide a positive value; omit to disable automatic requeue on timeout.
     */
    ackTimeout?: number;
    /**
     * Maximum number of delivery attempts before the message is dead-lettered or dropped.
     * Values <= 0 are invalid.
     */
    maxDeliveries?: number;
    /**
     * Destination queue for messages that exhaust `maxDeliveries`.
     */
    deadLetterQueue?: string;
}

export interface PublishOptions extends QueueOptions {
    /**
     * Custom message identifier. Defaults to an auto-generated value.
     */
    messageId?: string;
    /**
     * Arbitrary metadata passed to the consumer alongside the payload.
     */
    metadata?: Record<string, unknown>;
    /**
     * Override enqueue timestamp (primarily for tests).
     */
    enqueuedAt?: number;
}

export interface NackOptions {
    /**
     * When `true` (default) the message is placed back on the queue unless delivery limits are hit.
     */
    requeue?: boolean;
    /**
     * Optional marker recorded in diagnostics when the message leaves the queue.
     */
    reason?: string;
}

export interface MessageContext<T> {
    /**
     * Queue name that produced the message.
     */
    queue: string;
    /**
     * Unique identifier assigned to the message.
     */
    messageId: string;
    /**
     * Original payload supplied on publish.
     */
    payload: T;
    /**
     * Additional metadata carried with the payload.
     */
    metadata: Readonly<Record<string, unknown>>;
    /**
     * Enqueue timestamp in milliseconds.
     */
    enqueuedAt: number;
    /**
     * Number of times this message has been delivered (including the current attempt).
     */
    attempts: number;
    /**
     * `true` when the message has been redelivered at least once.
     */
    redelivered: boolean;
    /**
     * Confirm the message so it will not be re-delivered.
     */
    ack(): void;
    /**
     * Reject the message. When `requeue` is omitted or `true`, the message is re-enqueued until
     * the delivery limit is reached.
     */
    nack(options?: NackOptions): void;
}

export type MessageHandler<T> = (context: MessageContext<T>) => void | Promise<void>;

export interface ConsumerOptions extends QueueOptions {
    /**
     * Launch multiple worker instances for the handler. Each instance processes a single message
     * at any given time; default is 1.
     */
    instances?: number;
    /**
     * Whether to acknowledge messages automatically after the handler resolves successfully.
     */
    autoAck?: boolean;
}

export interface StopConsumerOptions {
    /**
     * When `true`, waits for in-flight messages to settle instead of requeuing them immediately.
     */
    drain?: boolean;
    /**
     * Requeue messages that are currently being processed when `drain` is `false`. Defaults to
     * `true`.
     */
    requeueInFlight?: boolean;
}

export interface ConsumerHandle {
    /**
     * Internal identifier of the consumer group.
     */
    readonly id: string;
    /**
     * Queue name the consumer is attached to.
     */
    readonly queue: string;
    pause(): void;
    resume(): void;
    isPaused(): boolean;
    /**
     * Count of deliveries currently in progress for this consumer group.
     */
    activeDeliveries(): number;
    /**
     * Stop the consumer. When `drain` is `true` the call resolves once outstanding deliveries end.
     */
    stop(options?: StopConsumerOptions): Promise<void>;
}

export interface QueueStats {
    queue: string;
    messages: number;
    pending: number;
    consumers: number;
    enqueued: number;
    delivered: number;
    acked: number;
    nacked: number;
    requeued: number;
    deadLettered: number;
    expired: number;
    dropped: number;
}

export interface LocalQueueOptions {
    /**
     * Defaults applied when queues are declared implicitly.
     */
    defaultQueue?: QueueOptions;
    /**
     * Clock override used in tests.
     */
    timeProvider?: () => number;
}
