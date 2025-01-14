import * as assert from 'assert';

import { Clock, install } from '@sinonjs/fake-timers';

import { E_CANCELED } from '../src/errors';
import Mutex from '../src/Mutex';
import MutexInterface from '../src/MutexInterface';
import { withTimer } from './util';

export const mutexSuite = (factory: (cancelError?: Error) => MutexInterface): void => {
    let mutex: MutexInterface;
    let clock: Clock;

    setup(() => {
        clock = install();
        mutex = factory();
    });

    teardown(() => clock.uninstall());

    test('ownership is exclusive', () =>
        withTimer(clock, async () => {
            let flag = false;

            const release = await mutex.acquire();

            setTimeout(() => {
                flag = true;
                release();
            }, 50);

            assert(!flag);

            (await mutex.acquire())();

            assert(flag);
        }));

    test('runExclusive passes result (immediate)', async () => {
        assert.strictEqual(await mutex.runExclusive(() => 10), 10);
    });

    test('runExclusive passes result (promise)', async () => {
        assert.strictEqual(await mutex.runExclusive(() => Promise.resolve(10)), 10);
    });

    test('runExclusive passes rejection', async () => {
        await assert.rejects(
            mutex.runExclusive(() => Promise.reject(new Error('foo'))),
            new Error('foo')
        );
    });

    test('runExclusive passes exception', async () => {
        await assert.rejects(
            mutex.runExclusive(() => {
                throw new Error('foo');
            }),
            new Error('foo')
        );
    });

    test('runExclusive is exclusive', () =>
        withTimer(clock, async () => {
            let flag = false;

            mutex.runExclusive(
                () =>
                    new Promise((resolve) =>
                        setTimeout(() => {
                            flag = true;
                            resolve(undefined);
                        }, 50)
                    )
            );

            assert(!flag);

            await mutex.runExclusive(() => undefined);

            assert(flag);
        }));

    test('exceptions during runExclusive do not leave mutex locked', async () => {
        let flag = false;

        mutex
            .runExclusive<number>(() => {
                flag = true;
                throw new Error();
            })
            .then(undefined, () => undefined);

        assert(!flag);

        await mutex.runExclusive(() => undefined);

        assert(flag);
    });

    test('new mutex is unlocked', () => {
        assert(!mutex.isLocked());
    });

    test('isLocked reflects the mutex state', async () => {
        const lock1 = mutex.acquire(),
            lock2 = mutex.acquire();

        assert(mutex.isLocked());

        const releaser1 = await lock1;

        assert(mutex.isLocked());

        releaser1();

        assert(mutex.isLocked());

        const releaser2 = await lock2;

        assert(mutex.isLocked());

        releaser2();

        assert(!mutex.isLocked());
    });

    test('the release method releases a locked mutex', async () => {
        await mutex.acquire();

        assert(mutex.isLocked());

        mutex.release();

        assert(!mutex.isLocked());
    });

    test('calling release on a unlocked mutex does not throw', () => {
        mutex.release();
    });

    test('multiple calls to release behave as expected', async () => {
        let v = 0;

        const run = async () => {
            await mutex.acquire();

            v++;

            mutex.release();
        };

        await Promise.all([run(), run(), run()]);

        assert.strictEqual(v, 3);
    });

    test('cancel rejects all pending locks witth E_CANCELED', async () => {
        await mutex.acquire();

        const ticket = mutex.acquire();
        const result = mutex.runExclusive(() => undefined);

        mutex.cancel();

        await assert.rejects(ticket, E_CANCELED);
        await assert.rejects(result, E_CANCELED);
    });

    test('cancel rejects with a custom error if provided', async () => {
        const err = new Error();
        const mutex = factory(err);

        await mutex.acquire();

        const ticket = mutex.acquire();

        mutex.cancel();

        await assert.rejects(ticket, err);
    });

    test('a canceled lock will not lock the mutex again', async () => {
        const release = await mutex.acquire();

        mutex.acquire().then(undefined, () => undefined);
        mutex.cancel();

        assert(mutex.isLocked());

        release();

        assert(!mutex.isLocked());
    });

    test('waitForUnlock does not block while the mutex has not been acquired', async () => {
        let taskCalls = 0;

        const awaitUnlockWrapper = async () => {
            await mutex.waitForUnlock();
            taskCalls++;
        };

        awaitUnlockWrapper();
        awaitUnlockWrapper();
        await clock.tickAsync(1);

        assert.strictEqual(taskCalls, 2);
    });

    test('waitForUnlock blocks when the mutex has been acquired', async () => {
        let taskCalls = 0;

        const awaitUnlockWrapper = async () => {
            await mutex.waitForUnlock();
            taskCalls++;
        };

        mutex.acquire();

        awaitUnlockWrapper();
        awaitUnlockWrapper();
        await clock.tickAsync(0);

        assert.strictEqual(taskCalls, 0);
    });

    test('waitForUnlock unblocks after a release', async () => {
        let taskCalls = 0;

        const awaitUnlockWrapper = async () => {
            await mutex.waitForUnlock();
            taskCalls++;
        };

        const releaser = await mutex.acquire();

        awaitUnlockWrapper();
        awaitUnlockWrapper();
        await clock.tickAsync(0);

        assert.strictEqual(taskCalls, 0);

        releaser();

        await clock.tickAsync(0);

        assert.strictEqual(taskCalls, 2);
    });
};

suite('Mutex', () => mutexSuite((e) => new Mutex(e)));
