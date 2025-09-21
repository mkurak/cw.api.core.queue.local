import { jest } from '@jest/globals';
import { Container, registerModules, resetContainer, getContainer } from 'cw.api.core.di';
import { LocalQueue, queueModule, useQueue } from '../src/index.js';
import { waitFor } from './helpers.js';

describe('queueModule', () => {
    afterEach(async () => {
        await resetContainer();
        jest.restoreAllMocks();
    });

    it('registers LocalQueue as singleton', () => {
        const container = new Container();
        registerModules(container, queueModule);

        const first = container.resolve(LocalQueue);
        const second = container.resolve(LocalQueue);

        expect(first).toBeInstanceOf(LocalQueue);
        expect(first).toBe(second);
    });

    it('useQueue returns shared instance from default container', () => {
        const resolved = useQueue();
        const container = getContainer();

        expect(resolved).toBeInstanceOf(LocalQueue);
        expect(container.resolve(LocalQueue)).toBe(resolved);
    });

    it('applies default queue configuration only once', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const queue = useQueue({
            defaultQueue: {
                ackTimeout: 10,
                maxDeliveries: 1
            }
        });

        queue.registerConsumer('jobs', () => undefined);
        queue.publish('jobs', 'task');

        await waitFor(() => queue.getQueueStats('jobs').dropped === 1);

        const sameQueue = useQueue({
            defaultQueue: {
                ackTimeout: 100
            }
        });

        expect(sameQueue).toBe(queue);
        expect(warnSpy).toHaveBeenCalled();
    });
});
