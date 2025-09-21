import {
    Lifecycle,
    createModule,
    getContainer,
    registerModules,
    type Container
} from 'cw.api.core.di';
import { LocalQueue } from './localQueue.js';
import type { QueueOptions } from './types.js';

const configuredQueues = new WeakSet<LocalQueue>();

export const queueModule = createModule({
    name: 'cw.api.core.queue.local',
    providers: [
        {
            useClass: LocalQueue,
            options: {
                lifecycle: Lifecycle.Singleton
            }
        }
    ],
    exports: [LocalQueue]
});

export interface UseQueueOptions {
    container?: Container;
    defaultQueue?: QueueOptions;
    configure?: (queue: LocalQueue) => void;
}

export function useQueue(options: UseQueueOptions = {}): LocalQueue {
    const container = options.container ?? getContainer();
    registerModules(container, queueModule);
    const queue = container.resolve(LocalQueue);

    if (options.defaultQueue) {
        if (!configuredQueues.has(queue)) {
            queue.configure({ defaultQueue: options.defaultQueue });
            configuredQueues.add(queue);
        } else {
            console.warn(
                '[cw.api.core.queue.local] useQueue(): defaultQueue already applied to shared instance; ignoring subsequent call.'
            );
        }
    }

    options.configure?.(queue);
    return queue;
}
