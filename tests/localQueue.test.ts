import { jest } from '@jest/globals';
import { LocalQueue } from '../src/localQueue.js';
import { waitFor } from './helpers.js';

describe('LocalQueue', () => {
    beforeEach(() => {
        jest.useRealTimers();
    });

    it('delivers and acknowledges messages', async () => {
        const queue = new LocalQueue();
        const seen: Array<string> = [];

        queue.registerConsumer('jobs', (ctx) => {
            seen.push(ctx.payload as string);
            ctx.ack();
        });

        queue.publish('jobs', 'task-1');

        await waitFor(() => queue.getQueueStats('jobs').acked === 1);
        expect(seen).toEqual(['task-1']);
        const stats = queue.getQueueStats('jobs');
        expect(stats.messages).toBe(0);
        expect(stats.pending).toBe(0);
    });

    it('redelivers messages when nack is invoked', async () => {
        const queue = new LocalQueue();
        const attempts: Array<{ id: string; redelivered: boolean }> = [];

        queue.registerConsumer('jobs', (ctx) => {
            attempts.push({ id: ctx.messageId, redelivered: ctx.redelivered });
            if (ctx.redelivered) {
                ctx.ack();
            } else {
                ctx.nack();
            }
        });

        queue.publish('jobs', 'task');

        await waitFor(() => queue.getQueueStats('jobs').acked === 1);
        expect(attempts).toHaveLength(2);
        expect(attempts[0].id).toBe(attempts[1].id);
        expect(attempts[0].redelivered).toBe(false);
        expect(attempts[1].redelivered).toBe(true);
    });

    it('distributes workload across consumer instances', async () => {
        const queue = new LocalQueue();
        const processed: string[] = [];
        const acknowledgers: Array<() => void> = [];

        queue.registerConsumer(
            'jobs',
            (ctx) => {
                processed.push(ctx.payload as string);
                return new Promise<void>((resolve) => {
                    acknowledgers.push(() => {
                        ctx.ack();
                        resolve();
                    });
                });
            },
            { instances: 2 }
        );

        queue.publish('jobs', 'task-a');
        queue.publish('jobs', 'task-b');

        await waitFor(() => processed.length === 2);
        expect(processed.sort()).toEqual(['task-a', 'task-b']);

        acknowledgers.forEach((acknowledge) => acknowledge());
        await waitFor(() => queue.getQueueStats('jobs').acked === 2);
        expect(queue.getQueueStats('jobs').pending).toBe(0);
    });

    it('dead-letters messages after max deliveries are exhausted', async () => {
        const queue = new LocalQueue({
            defaultQueue: {
                ackTimeout: 10,
                maxDeliveries: 2,
                deadLetterQueue: 'dead'
            }
        });
        const dead: string[] = [];

        queue.registerConsumer('dead', (ctx) => {
            dead.push(ctx.payload as string);
            ctx.ack();
        });

        queue.registerConsumer('jobs', () => undefined);

        queue.publish('jobs', 'failing-task');

        await waitFor(() => dead.length === 1, { timeout: 2000 });
        expect(dead).toEqual(['failing-task']);
        const stats = queue.getQueueStats('jobs');
        expect(stats.deadLettered).toBe(1);
        expect(stats.dropped).toBe(0);
    });

    it('stop() drains in-flight messages when requested', async () => {
        const queue = new LocalQueue();
        const acknowledgers: Array<() => void> = [];
        const handle = queue.registerConsumer('jobs', (ctx) => {
            return new Promise<void>((resolve) => {
                acknowledgers.push(() => {
                    ctx.ack();
                    resolve();
                });
            });
        });

        queue.publish('jobs', 'task');
        await waitFor(() => queue.getQueueStats('jobs').pending === 1);

        const stopPromise = handle.stop({ drain: true });
        expect(handle.isPaused()).toBe(true);
        acknowledgers.forEach((fn) => fn());
        await stopPromise;
        expect(queue.getQueueStats('jobs').acked).toBe(1);
    });

    it('validates option inputs and normalises queue configuration', () => {
        const queue = new LocalQueue();

        expect(() => queue.publish('jobs', 'task', { ackTimeout: 0 })).toThrow(
            /ackTimeout must be a positive finite number/
        );

        expect(() =>
            queue.registerConsumer('jobs', () => undefined, { maxDeliveries: -1 })
        ).toThrow(/maxDeliveries must be a positive finite number/);

        queue.declareQueue('jobs', {
            ackTimeout: 100,
            maxDeliveries: 5,
            deadLetterQueue: 'dlq'
        });

        queue.declareQueue('jobs', {
            ackTimeout: 200,
            deadLetterQueue: 'dlq-updated'
        });

        const stats = queue.getQueueStats('jobs');
        expect(stats.queue).toBe('jobs');
    });

    it('supports pausing, resuming, purging, and deleting queues', async () => {
        const queue = new LocalQueue();
        const delivered: string[] = [];

        queue.registerConsumer('jobs', (ctx) => {
            delivered.push(ctx.payload as string);
            ctx.ack();
        });

        queue.pauseQueue('jobs');
        queue.publish('jobs', 'task-paused');

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(delivered).toHaveLength(0);

        queue.resumeQueue('jobs');
        await waitFor(() => delivered.length === 1);

        queue.pauseQueue('jobs');
        queue.publish('jobs', 'task-purged');
        expect(queue.purgeQueue('jobs')).toBe(1);
        expect(queue.getQueueStats('jobs').messages).toBe(0);

        queue.deleteQueue('jobs');
        expect(() => queue.getQueueStats('jobs')).toThrow(/not declared/);
        expect(queue.listQueues()).not.toContain('jobs');
    });

    it('prevents double settlement of messages', async () => {
        const queue = new LocalQueue();

        queue.registerConsumer('jobs', (ctx) => {
            ctx.ack();
            expect(() => ctx.ack()).toThrow('Message already settled.');
            expect(() => ctx.nack()).toThrow('Message already settled.');
        });

        queue.publish('jobs', 'task');
        await waitFor(() => queue.getQueueStats('jobs').acked === 1);
    });

    it('exposes consumer handle controls', async () => {
        const queue = new LocalQueue();
        const processed: string[] = [];
        const handle = queue.registerConsumer('jobs', (ctx) => {
            processed.push(ctx.payload as string);
            expect(handle.activeDeliveries()).toBeGreaterThan(0);
            ctx.ack();
        });

        queue.publish('jobs', 'first');
        await waitFor(() => processed.length === 1);
        expect(handle.isPaused()).toBe(false);

        handle.pause();
        expect(handle.isPaused()).toBe(true);
        queue.publish('jobs', 'second');
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(processed).toEqual(['first']);

        handle.resume();
        await waitFor(() => processed.length === 2);
        expect(handle.queue).toBe('jobs');
        expect(handle.id).toMatch(/-/);
    });

    it('drops in-flight messages when stop() is called without requeue', async () => {
        const queue = new LocalQueue();
        let resolveDelivery!: () => void;

        const handle = queue.registerConsumer('jobs', () => {
            return new Promise<void>((resolve) => {
                resolveDelivery = resolve;
            });
        });

        queue.publish('jobs', 'task');
        await waitFor(() => queue.getQueueStats('jobs').pending === 1);

        await handle.stop({ requeueInFlight: false });
        expect(queue.getQueueStats('jobs').pending).toBe(0);
        expect(queue.getQueueStats('jobs').dropped).toBe(1);

        resolveDelivery();
    });

    it('requeues messages when handlers throw', async () => {
        const queue = new LocalQueue({
            defaultQueue: {
                maxDeliveries: 2
            }
        });
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        const attempts: number[] = [];

        queue.registerConsumer('jobs', (ctx) => {
            attempts.push(ctx.attempts);
            if (ctx.attempts === 1) {
                throw new Error('fail');
            }
            ctx.ack();
        });

        queue.publish('jobs', 'task');
        await waitFor(() => queue.getQueueStats('jobs').acked === 1);

        expect(attempts).toEqual([1, 2]);
        expect(queue.getQueueStats('jobs').requeued).toBeGreaterThanOrEqual(1);
        expect(errorSpy).toHaveBeenCalled();
        errorSpy.mockRestore();
    });

    it('processes large batches efficiently', async () => {
        const queue = new LocalQueue();
        let count = 0;

        queue.registerConsumer(
            'bulk',
            () => {
                count += 1;
            },
            { autoAck: true }
        );

        for (let i = 0; i < 64; i += 1) {
            queue.publish('bulk', i);
        }

        await waitFor(() => count === 64, { timeout: 2000 });
        expect(queue.getQueueStats('bulk').acked).toBe(64);
    });
});
