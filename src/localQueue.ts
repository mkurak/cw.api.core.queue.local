import { randomUUID } from 'node:crypto';
import type {
    ConsumerHandle,
    ConsumerOptions,
    LocalQueueOptions,
    MessageContext,
    MessageHandler,
    NackOptions,
    PublishOptions,
    QueueOptions,
    QueueStats,
    StopConsumerOptions
} from './types.js';

const MAX_ATTEMPTS_DEFAULT = Number.POSITIVE_INFINITY;

interface NormalisedQueueOptions {
    ackTimeout?: number;
    maxDeliveries: number;
    deadLetterQueue?: string;
}

interface NormalisedConsumerOptions extends NormalisedQueueOptions {
    instances: number;
    autoAck: boolean;
}

interface QueueMessage<T = unknown> {
    id: string;
    payload: T;
    metadata: Record<string, unknown>;
    enqueuedAt: number;
    attempts: number;
    ackTimeout?: number;
    maxDeliveries?: number;
    deadLetterQueue?: string;
}

interface QueueMetrics {
    enqueued: number;
    delivered: number;
    acked: number;
    nacked: number;
    requeued: number;
    deadLettered: number;
    expired: number;
    dropped: number;
}

interface Delivery {
    id: string;
    queue: QueueState;
    consumer: ConsumerGroup;
    worker: ConsumerWorker;
    message: QueueMessage;
    deliveredAt: number;
    ackTimer?: NodeJS.Timeout;
    settled: boolean;
    settleReason?: string;
}

interface ConsumerGroup {
    id: string;
    handler: MessageHandler<unknown>;
    options: NormalisedConsumerOptions;
    workers: ConsumerWorker[];
    paused: boolean;
    disposed: boolean;
    activeDeliveries: number;
    waiters: Array<() => void>;
}

interface ConsumerWorker {
    id: string;
    consumer: ConsumerGroup;
    busy: boolean;
    delivery?: Delivery;
}

class MessageBuffer<T> {
    private items: T[] = [];
    private head = 0;

    enqueue(item: T): void {
        this.items.push(item);
    }

    dequeue(): T | undefined {
        if (this.head >= this.items.length) {
            this.reset();
            return undefined;
        }
        const value = this.items[this.head++];
        if (this.head > 32 && this.head * 2 >= this.items.length) {
            this.items = this.items.slice(this.head);
            this.head = 0;
        }
        return value;
    }

    get size(): number {
        return this.items.length - this.head;
    }

    clear(): void {
        this.items = [];
        this.head = 0;
    }

    private reset(): void {
        this.items = [];
        this.head = 0;
    }
}

interface QueueState {
    name: string;
    options: NormalisedQueueOptions;
    buffer: MessageBuffer<QueueMessage>;
    consumers: Map<string, ConsumerGroup>;
    workers: ConsumerWorker[];
    deliveries: Map<string, Delivery>;
    metrics: QueueMetrics;
}

function nowFactory(options?: LocalQueueOptions): () => number {
    return options?.timeProvider ?? Date.now;
}

function normaliseAckTimeout(source: string, value: number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${source}: ackTimeout must be a positive finite number.`);
    }
    return value;
}

function normaliseMaxDeliveries(source: string, value: number | undefined): number | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`${source}: maxDeliveries must be a positive finite number.`);
    }
    const rounded = Math.floor(value);
    if (rounded !== value) {
        throw new Error(`${source}: maxDeliveries must be an integer.`);
    }
    return rounded;
}

function normaliseQueueOptions(options?: QueueOptions): NormalisedQueueOptions {
    return {
        ackTimeout: normaliseAckTimeout('Queue options', options?.ackTimeout),
        maxDeliveries:
            normaliseMaxDeliveries('Queue options', options?.maxDeliveries) ?? MAX_ATTEMPTS_DEFAULT,
        deadLetterQueue:
            options?.deadLetterQueue?.trim() === '' ? undefined : options?.deadLetterQueue
    };
}

function normaliseConsumerOptions(options?: ConsumerOptions): NormalisedConsumerOptions {
    const instancesRaw = options?.instances ?? 1;
    const instances = Math.max(1, Math.floor(instancesRaw));
    const deadLetterQueue =
        options?.deadLetterQueue?.trim() === '' ? undefined : options?.deadLetterQueue;
    return {
        instances,
        autoAck: options?.autoAck ?? false,
        ackTimeout: normaliseAckTimeout('Consumer options', options?.ackTimeout),
        maxDeliveries:
            normaliseMaxDeliveries('Consumer options', options?.maxDeliveries) ??
            MAX_ATTEMPTS_DEFAULT,
        deadLetterQueue
    };
}

function freezeMetadata(source?: Record<string, unknown>): Record<string, unknown> {
    if (!source || Object.keys(source).length === 0) {
        return Object.freeze({});
    }
    return Object.freeze({ ...source });
}

function createQueueMetrics(): QueueMetrics {
    return {
        enqueued: 0,
        delivered: 0,
        acked: 0,
        nacked: 0,
        requeued: 0,
        deadLettered: 0,
        expired: 0,
        dropped: 0
    };
}

/**
 * Lightweight in-memory queue manager with consumer orchestration.
 */
export class LocalQueue {
    private readonly queues = new Map<string, QueueState>();
    private readonly now: () => number;
    private defaultQueue: NormalisedQueueOptions;

    constructor(options: LocalQueueOptions = {}) {
        this.now = nowFactory(options);
        this.defaultQueue = normaliseQueueOptions(options.defaultQueue);
    }

    configure(options: { defaultQueue?: QueueOptions } = {}): void {
        if (options.defaultQueue) {
            this.defaultQueue = normaliseQueueOptions(options.defaultQueue);
        }
    }

    declareQueue(name: string, options?: QueueOptions): void {
        const queue = this.queues.get(name);
        if (!queue) {
            this.queues.set(name, {
                name,
                options: options ? normaliseQueueOptions(options) : { ...this.defaultQueue },
                buffer: new MessageBuffer<QueueMessage>(),
                consumers: new Map(),
                workers: [],
                deliveries: new Map(),
                metrics: createQueueMetrics()
            });
            return;
        }
        if (options) {
            const ackTimeout =
                options.ackTimeout ??
                (options.ackTimeout === null ? undefined : queue.options.ackTimeout);
            const maxDeliveries =
                options.maxDeliveries ??
                (options.maxDeliveries === null
                    ? undefined
                    : queue.options.maxDeliveries === MAX_ATTEMPTS_DEFAULT
                      ? undefined
                      : queue.options.maxDeliveries);
            const deadLetterQueue =
                options.deadLetterQueue ??
                (options.deadLetterQueue === null ? undefined : queue.options.deadLetterQueue);
            queue.options = normaliseQueueOptions({
                ackTimeout: ackTimeout ?? undefined,
                maxDeliveries,
                deadLetterQueue
            });
        }
    }

    publish<T>(queueName: string, payload: T, options: PublishOptions = {}): string {
        const queue = this.ensureQueue(queueName);
        const message: QueueMessage<T> = {
            id: options.messageId ?? randomUUID(),
            payload,
            metadata: freezeMetadata(options.metadata),
            enqueuedAt: options.enqueuedAt ?? this.now(),
            attempts: 0,
            ackTimeout: normaliseAckTimeout('Publish options', options.ackTimeout),
            maxDeliveries: normaliseMaxDeliveries('Publish options', options.maxDeliveries),
            deadLetterQueue:
                options.deadLetterQueue?.trim() === '' ? undefined : options.deadLetterQueue
        };
        queue.buffer.enqueue(message);
        queue.metrics.enqueued += 1;
        this.dispatch(queue);
        return message.id;
    }

    registerConsumer<T>(
        queueName: string,
        handler: MessageHandler<T>,
        options: ConsumerOptions = {}
    ): ConsumerHandle {
        const queue = this.ensureQueue(queueName);
        const consumerOptions = normaliseConsumerOptions(options);
        const consumer: ConsumerGroup = {
            id: randomUUID(),
            handler: handler as MessageHandler<unknown>,
            options: consumerOptions,
            workers: [],
            paused: false,
            disposed: false,
            activeDeliveries: 0,
            waiters: []
        };

        for (let i = 0; i < consumerOptions.instances; i += 1) {
            const worker: ConsumerWorker = {
                id: `${consumer.id}:${i}`,
                consumer,
                busy: false
            };
            consumer.workers.push(worker);
            queue.workers.push(worker);
        }

        queue.consumers.set(consumer.id, consumer);
        this.dispatch(queue);

        const handle: ConsumerHandle = {
            get id() {
                return consumer.id;
            },
            get queue() {
                return queue.name;
            },
            pause: () => {
                if (!consumer.disposed) {
                    consumer.paused = true;
                }
            },
            resume: () => {
                if (!consumer.disposed) {
                    consumer.paused = false;
                    this.dispatch(queue);
                }
            },
            isPaused: () => consumer.paused,
            activeDeliveries: () => consumer.activeDeliveries,
            stop: async (stopOptions?: StopConsumerOptions) => {
                await this.stopConsumer(queue, consumer, stopOptions);
            }
        };

        return handle;
    }

    pauseQueue(name: string): void {
        const queue = this.queues.get(name);
        if (!queue) {
            return;
        }
        for (const consumer of queue.consumers.values()) {
            consumer.paused = true;
        }
    }

    resumeQueue(name: string): void {
        const queue = this.queues.get(name);
        if (!queue) {
            return;
        }
        for (const consumer of queue.consumers.values()) {
            consumer.paused = false;
        }
        this.dispatch(queue);
    }

    purgeQueue(name: string): number {
        const queue = this.queues.get(name);
        if (!queue) {
            return 0;
        }
        const dropped = queue.buffer.size;
        queue.buffer.clear();
        queue.metrics.dropped += dropped;
        return dropped;
    }

    deleteQueue(name: string): void {
        const queue = this.queues.get(name);
        if (!queue) {
            return;
        }
        for (const delivery of queue.deliveries.values()) {
            this.nackInternal(delivery, { requeue: false, reason: 'queue-deleted' }, true);
        }
        queue.deliveries.clear();
        this.queues.delete(name);
    }

    getQueueStats(name: string): QueueStats {
        const queue = this.queues.get(name);
        if (!queue) {
            throw new Error(`Queue ${name} is not declared.`);
        }
        return {
            queue: queue.name,
            messages: queue.buffer.size,
            pending: queue.deliveries.size,
            consumers: queue.consumers.size,
            enqueued: queue.metrics.enqueued,
            delivered: queue.metrics.delivered,
            acked: queue.metrics.acked,
            nacked: queue.metrics.nacked,
            requeued: queue.metrics.requeued,
            deadLettered: queue.metrics.deadLettered,
            expired: queue.metrics.expired,
            dropped: queue.metrics.dropped
        };
    }

    listQueues(): string[] {
        return Array.from(this.queues.keys());
    }

    private ensureQueue(name: string): QueueState {
        let queue = this.queues.get(name);
        if (!queue) {
            queue = {
                name,
                options: { ...this.defaultQueue },
                buffer: new MessageBuffer<QueueMessage>(),
                consumers: new Map(),
                workers: [],
                deliveries: new Map(),
                metrics: createQueueMetrics()
            };
            this.queues.set(name, queue);
        }
        return queue;
    }

    private dispatch(queue: QueueState): void {
        while (true) {
            const worker = this.nextAvailableWorker(queue);
            if (!worker) {
                return;
            }
            const message = queue.buffer.dequeue();
            if (!message) {
                return;
            }
            this.deliver(queue, worker, message);
        }
    }

    private nextAvailableWorker(queue: QueueState): ConsumerWorker | undefined {
        for (const worker of queue.workers) {
            if (worker.busy) {
                continue;
            }
            if (worker.consumer.paused || worker.consumer.disposed) {
                continue;
            }
            return worker;
        }
        return undefined;
    }

    private deliver(queue: QueueState, worker: ConsumerWorker, message: QueueMessage): void {
        worker.busy = true;
        message.attempts += 1;
        const delivery: Delivery = {
            id: randomUUID(),
            queue,
            consumer: worker.consumer,
            worker,
            message,
            deliveredAt: this.now(),
            settled: false
        };
        worker.delivery = delivery;
        worker.consumer.activeDeliveries += 1;
        queue.deliveries.set(delivery.id, delivery);
        queue.metrics.delivered += 1;

        const ackTimeout = this.resolveAckTimeout(delivery);
        if (ackTimeout !== undefined) {
            delivery.ackTimer = setTimeout(() => this.handleAckTimeout(delivery), ackTimeout);
        }

        const context: MessageContext<unknown> = {
            queue: queue.name,
            messageId: message.id,
            payload: message.payload,
            metadata: message.metadata,
            enqueuedAt: message.enqueuedAt,
            attempts: message.attempts,
            redelivered: message.attempts > 1,
            ack: () => this.ack(delivery),
            nack: (options?: NackOptions) => this.nack(delivery, options)
        };

        let handlerResult: Promise<void>;
        try {
            const value = worker.consumer.handler(context);
            handlerResult = Promise.resolve(value).then(() => undefined);
        } catch (error) {
            handlerResult = Promise.reject(error);
        }

        handlerResult
            .then(() => {
                if (worker.consumer.options.autoAck) {
                    this.ack(delivery);
                }
            })
            .catch((error) => {
                this.nack(delivery, { requeue: true, reason: 'handler-error' });
                console.error('[LocalQueue] consumer handler failed:', error);
            });
    }

    private ack(delivery: Delivery): void {
        if (delivery.settled) {
            throw new Error('Message already settled.');
        }
        this.settle(delivery, 'ack');
        delivery.queue.metrics.acked += 1;
        this.completeDelivery(delivery);
    }

    private nack(delivery: Delivery, options: NackOptions = {}): void {
        this.nackInternal(delivery, options, false);
    }

    private nackInternal(delivery: Delivery, options: NackOptions, silent: boolean): void {
        if (delivery.settled) {
            if (!silent) {
                throw new Error('Message already settled.');
            }
            return;
        }
        const queue = delivery.queue;
        this.settle(delivery, options.reason ?? 'nack');
        queue.metrics.nacked += 1;
        const maxDeliveries = this.resolveMaxDeliveries(delivery);
        const shouldRequeue = options.requeue !== false;

        if (!shouldRequeue) {
            queue.metrics.dropped += 1;
            this.completeDelivery(delivery);
            return;
        }

        if (delivery.message.attempts >= maxDeliveries) {
            this.moveToDeadLetter(delivery, options.reason ?? 'max-deliveries-exceeded');
            return;
        }

        queue.metrics.requeued += 1;
        queue.buffer.enqueue(delivery.message);
        this.completeDelivery(delivery);
        this.dispatch(queue);
    }

    private settle(delivery: Delivery, reason: string): void {
        delivery.settled = true;
        delivery.settleReason = reason;
        if (delivery.ackTimer) {
            clearTimeout(delivery.ackTimer);
        }
    }

    private completeDelivery(delivery: Delivery): void {
        const queue = delivery.queue;
        queue.deliveries.delete(delivery.id);
        const worker = delivery.worker;
        worker.busy = false;
        worker.delivery = undefined;
        const consumer = delivery.consumer;
        consumer.activeDeliveries -= 1;
        this.notifyConsumerIdle(consumer);
        if (!consumer.paused && !consumer.disposed) {
            this.dispatch(queue);
        }
    }

    private resolveAckTimeout(delivery: Delivery): number | undefined {
        return (
            delivery.message.ackTimeout ??
            delivery.consumer.options.ackTimeout ??
            delivery.queue.options.ackTimeout
        );
    }

    private resolveMaxDeliveries(delivery: Delivery): number {
        const messageLimit = delivery.message.maxDeliveries;
        if (messageLimit !== undefined) {
            return messageLimit;
        }
        const consumerLimit = delivery.consumer.options.maxDeliveries;
        if (consumerLimit !== undefined && consumerLimit !== MAX_ATTEMPTS_DEFAULT) {
            return consumerLimit;
        }
        return delivery.queue.options.maxDeliveries;
    }

    private resolveDeadLetterQueue(delivery: Delivery): string | undefined {
        return (
            delivery.message.deadLetterQueue ??
            delivery.consumer.options.deadLetterQueue ??
            delivery.queue.options.deadLetterQueue
        );
    }

    private handleAckTimeout(delivery: Delivery): void {
        if (delivery.settled) {
            return;
        }
        delivery.queue.metrics.expired += 1;
        this.nackInternal(delivery, { requeue: true, reason: 'ack-timeout' }, true);
    }

    private moveToDeadLetter(delivery: Delivery, reason: string): void {
        const queue = delivery.queue;
        queue.metrics.deadLettered += 1;
        const deadLetterQueue = this.resolveDeadLetterQueue(delivery);
        this.completeDelivery(delivery);
        if (!deadLetterQueue) {
            queue.metrics.dropped += 1;
            return;
        }
        if (deadLetterQueue === queue.name) {
            queue.metrics.dropped += 1;
            return;
        }
        this.publish(deadLetterQueue, delivery.message.payload, {
            metadata: {
                ...delivery.message.metadata,
                'x-dead-letter-from': queue.name,
                'x-dead-letter-reason': reason,
                'x-dead-letter-attempts': delivery.message.attempts
            }
        });
    }

    private notifyConsumerIdle(consumer: ConsumerGroup): void {
        if (consumer.activeDeliveries > 0) {
            return;
        }
        if (consumer.waiters.length === 0) {
            return;
        }
        for (const resolve of consumer.waiters.splice(0)) {
            resolve();
        }
    }

    private async stopConsumer(
        queue: QueueState,
        consumer: ConsumerGroup,
        options: StopConsumerOptions = {}
    ): Promise<void> {
        if (consumer.disposed) {
            return;
        }
        consumer.paused = true;
        consumer.disposed = true;

        if (options.drain) {
            if (consumer.activeDeliveries > 0) {
                await new Promise<void>((resolve) => {
                    consumer.waiters.push(resolve);
                });
            }
        } else {
            const deliveries = Array.from(queue.deliveries.values()).filter(
                (delivery) => delivery.consumer === consumer
            );
            const requeue = options.requeueInFlight !== false;
            for (const delivery of deliveries) {
                this.nackInternal(delivery, { requeue, reason: 'consumer-stopped' }, true);
            }
        }

        queue.consumers.delete(consumer.id);
        queue.workers = queue.workers.filter((worker) => worker.consumer !== consumer);
        consumer.workers.length = 0;
    }
}
