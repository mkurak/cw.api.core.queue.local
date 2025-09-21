export async function waitFor(
    assertion: () => boolean,
    { timeout = 1000, interval = 5 }: { timeout?: number; interval?: number } = {}
): Promise<void> {
    const start = Date.now();
    while (!assertion()) {
        if (Date.now() - start > timeout) {
            throw new Error('waitFor: condition not met within timeout');
        }
        await new Promise((resolve) => setTimeout(resolve, interval));
    }
}
