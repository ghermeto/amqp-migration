/**
 * This integration tests require 2 rabbitmq instances:
 * source-mq.localhost:5672
 * dest-mq.localhost:5673
 * 
 * To bootstrap those run (in the command line):
 * $ docker pull rabbitmq:management
 * $ docker run -d --hostname source-mq.localhost --name source-mq -p 5672:5672 -p 15672:15672 rabbitmq:management
 * $ docker run -d --hostname dest-mq.localhost --name dest-mq -p 5673:5672 -p 15673:15672 rabbitmq:management
 * 
 * $ sudo vim /etc/hosts
 *  - 127.0.0.1 source-mq.localhost
 *  - 127.0.0.1 dest-mq.localhost
 * 
 * $ docker pull redis
 * $ docker run --name redis-store -p 6379:6379 -d redis
 * 
 * The tests will automatically create on broker source-mq.localhost (http://localhost:15672/):
 * - exchanges: test-exchange, fail-exchange
 * - queues: test-source, fail-queue
 * - bind: test-exchange -> test-source
 * 
 * The tests will automatically create on broker dest-mq.localhost (http://localhost:15673/):
 * - exchanges: test-exchange, fail-exchange
 * - queues: test-dest, test-source
 * - bind: test-exchange -> test-source; test-exchange -> test-dest
 */

import { assert } from 'chai';
import { AMQPClient } from '@cloudamqp/amqp-client';
import { createSandbox } from 'sinon';
import {once} from 'events';
import Redis from 'ioredis';
import { readFile } from 'fs/promises';
import { setTimeout as timeout } from 'timers/promises';


let envs = {};
process.env.LOG_LEVEL = 'error';

const sandbox = createSandbox();

const sourceBrokerURL = 'amqp://source-mq.localhost:5672';
const destBrokerURL = 'amqp://dest-mq.localhost:5673';

/**
 * initial queue, exchange and bindings setup
 */
async function prepareQueues() {
    const source = new AMQPClient(sourceBrokerURL);
    let sourceConn;
    let sourceChannel;

    try {
        sourceConn = await source.connect();
        sourceChannel = await sourceConn.channel();
        await sourceChannel.queueUnbind('test-source', 'test-exchange', '');
        await sourceChannel.queueDelete('test-source');
        await sourceChannel.queueDelete('fail-queue');
        await sourceChannel.exchangeDelete('test-exchange');
        await sourceChannel.exchangeDelete('fail-exchange');

        await sourceChannel.queueDeclare('test-source');
        await sourceChannel.queueDeclare('fail-queue');
        await sourceChannel.exchangeDeclare('test-exchange', 'direct');
        await sourceChannel.exchangeDeclare('fail-exchange', 'direct');
        await sourceChannel.queueBind('test-source', 'test-exchange', '');
    } catch(e1) {
        console.info(e1);
        throw e1;
    } finally {
        if (sourceChannel && sourceChannel.close) sourceChannel.close();
        if (sourceConn && sourceConn.close) sourceConn.close();
    }

    const dest = new AMQPClient(destBrokerURL);
    let destConn;
    let destChannel;

    try {
        destConn = await dest.connect();
        destChannel = await destConn.channel();
        await destChannel.queueUnbind('test-source', 'test-exchange', '');
        await destChannel.queueUnbind('test-dest', 'test-exchange', '');
        await destChannel.queueDelete('test-source');
        await destChannel.queueDelete('test-dest');
        await destChannel.exchangeDelete('test-exchange');
        await destChannel.exchangeDelete('fail-exchange');

        await destChannel.queueDeclare('test-source');
        await destChannel.queueDeclare('test-dest');
        await destChannel.exchangeDeclare('test-exchange', 'direct');
        await destChannel.exchangeDeclare('fail-exchange', 'direct');
        await destChannel.queueBind('test-source', 'test-exchange', '');
        await destChannel.queueBind('test-dest', 'test-exchange', '');
    } catch(e2) {
        console.info(e2);
        throw e2;
    } finally {
        if (destChannel && destChannel.close) destChannel.close();
        if (destConn && destConn.close) destConn.close();
    }

}

async function read(path) {
    const url = new URL(path, import.meta.url);
    return await readFile(url, { encoding: 'utf-8'});
}

/**
 * use dynamic import to allow us to change env vars;
 */
async function load(env) {
    for(let key in env) {
        envs[key] = env[key];
    }
    return import(`../../runner.js?update=${Date.now()}`);
}

async function purgeTestQueue(url, name) {
    const amqp = new AMQPClient(url);
    const conn = await amqp.connect();
    const channel = await conn.channel();
    await channel.queuePurge(name);
    await conn.close();
}

async function getFromBroker(brokerUrl, queueName) {
    const amqp = new AMQPClient(brokerUrl);
    const conn = await amqp.connect();
    const channel = await conn.channel();
    const queue = await channel.queue(queueName);
    return { conn, channel, queue };
}

function* messageGenerator(numMessages = 1) {
    for (let index = 0; index < numMessages; index++) {
        yield `{"test": ${index}}`;
    }
}

describe('queue-migration', function () {
    this.timeout(5000);
    let originalEnv;

    before(() => {
        originalEnv = {...process.env};
    })
    
    beforeEach(() => {
        envs = originalEnv;
        delete envs.AMQP_DESTINATION_QUEUE;
        delete envs.REDIS_URL;
        delete envs.FILE_LOGS_PATH;
        sandbox.stub(process, 'env').value(envs);
    });

    afterEach(async () => {
        sandbox.restore();
        await prepareQueues();
    });


    it('should fail to connect to source if there is another client attached', async () => {

        // connect fake concurrent client
        const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'test-source');
        const consumer = await queue.subscribe({}, async (msg) => {
            assert.fail(msg);
        });

        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            assert.fail('Should throw async');
        } catch(err) {
            assert.equal(err.message, "channel 1 closed: ACCESS_REFUSED - queue 'test-source' in vhost '/' in exclusive use (403)");
        }

        //cleanup
        await channel.close();
        await conn.close();
        await closeConnections();

    });

    it('should fail to connect to source if queue name is not found', async () => {
        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-not-found',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            assert.fail('Should throw async');
        } catch(err) {
            assert.equal(err.message, "channel 1 closed: NOT_FOUND - no queue 'test-not-found' in vhost '/' (404)");
        }

        await closeConnections();
    });

    it('should publish on a named queue', async () => {
        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            AMQP_DESTINATION_QUEUE: 'test-dest',
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'test-source');
            await queue.publish('{"test": true}');
            await channel.close();
            await conn.close();

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should publish on a given exchange', async () => {
        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'test-source');
            await queue.publish('{"test": true}');
            await channel.close();
            await conn.close();

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should return message when exchange or routingRule do not exist', async () => {
        const {run, events, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'fail-queue',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'fail-queue');
            await queue.publish('{"test": true}');
            const returnedMessage = await once(events, 'returned');
            assert.isObject(returnedMessage[0]);
            await channel.close();
            await conn.close();

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should successfully publish an store message in redis', async () => {
        const redisUrl = 'redis://localhost:6379/9';
        const redis = new Redis(redisUrl);
        
        const {run, events, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false,
            REDIS_URL: redisUrl
        });

        try {
            await run();
            const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'test-source');
            await queue.publish('{"test": true}');
            await channel.close();
            await conn.close();
            await once(events, 'published');
            const list = await redis.keys('*');
            assert.lengthOf(list, 1);

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
        await redis.flushdb();

    })

    it('should successfully publish and store message in file', async () => {
        const filePath = '/tmp/logs';
        const {run, events, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: 'true',
            RETRY_ON_FAIL: false,
            FILE_LOGS_PATH: filePath
        });

        try {
            await run();
            const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'test-source');
            await queue.publish('{"test": true}');
            await channel.close();
            await conn.close();
            const [channelHost, id, data] = await once(events, 'published');
            const file = await readFile(`${filePath}/msg-${id}.txt`, { encoding: 'utf8' });
            assert.equal(file, '{"channel":1,"exchange":"","routingKey":"test-source","properties":{},"body":"{\\"test\\": true}"}');
        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should successfully publish a 2MB message', async () => {
        const file = await read('../data/2mb-file.txt');

        const {run, events, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            const { queue, channel, conn } = await getFromBroker(sourceBrokerURL, 'test-source');
            await queue.publish(JSON.stringify(file));
            await channel.close();
            await conn.close();
            const [channelHost, id, data] = await once(events, 'published');
            assert.ok(data.body.length > 2097152);
        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should do a full e2e', async () => {
        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            await run();
            const src = await getFromBroker(sourceBrokerURL, 'test-source');
            await src.queue.publish('{"test": true}');
            await src.channel.close();
            await src.conn.close();

            const dest = await getFromBroker(destBrokerURL, 'test-source');
            const consumer = await dest.queue.subscribe({ noAck: false }, async (msg) => {
                const body = msg.bodyToString();
                assert.equal(body, '{"test": true}');
                await msg.cancelConsumer();
            });

            await consumer.wait();
            await dest.channel.close();
            await dest.conn.close();

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should do a full e2e with multiple messages', async () => {
        const numMessages = 15;
        const testMessages = messageGenerator(numMessages);

        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            const src = await getFromBroker(sourceBrokerURL, 'test-source');
            let cache = [];
            for await (let message of testMessages) {
                cache.push(message);
                await src.queue.publish(message);
            }
            await src.channel.close();
            await src.conn.close();

            // run the migration after the queue has messages
            await run();

            let acks = 0;
            const dest = await getFromBroker(destBrokerURL, 'test-source');
            const consumer = await dest.queue.subscribe({ noAck: false }, async (msg) => {
                const body = msg.bodyToString();
                // remove images in order
                const expected = cache.shift();
                assert.equal(expected, body);
                await msg.ack();
                acks++;
                if (acks === numMessages) {
                    await msg.cancelConsumer();
                }
            });

            await consumer.wait();
            await dest.channel.close();
            await dest.conn.close();

            // make sure they were all read
            assert.equal(acks, numMessages);

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });

    it('should do a full e2e with multiple delayed messages', async () => {
        const numMessages = 5;
        const testMessages = messageGenerator(numMessages);

        const {run, closeConnections} = await load({
            AMQP_SOURCE_URL: sourceBrokerURL,
            AMQP_SOURCE_QUEUE: 'test-source',
            AMQP_DESTINATION_URL: destBrokerURL,
            ENABLE_FILE_LOGGER: false,
            RETRY_ON_FAIL: false
        });

        try {
            // run the migration first
            await run();

            const cache = [];
            const src = await getFromBroker(sourceBrokerURL, 'test-source');
            for await(let message of testMessages) {
                // delay sending a message
                cache.push(message);
                await timeout(150);
                await src.channel.basicPublish('', 'test-source', message, {});
            }
            await src.channel.close();
            await src.conn.close();

            let acks = 0;
            const dest = await getFromBroker(destBrokerURL, 'test-source');
            const consumer = await dest.queue.subscribe({ noAck: false }, async (msg) => {
                const body = msg.bodyToString();
                // remove images in order
                const expected = cache.shift();
                assert.equal(expected, body);
                await msg.ack();
                acks++;
                if (acks === numMessages) {
                    await msg.cancelConsumer();
                }
            });

            await consumer.wait();
            await dest.channel.close();
            await dest.conn.close();

            // make sure they were all read
            assert.equal(acks, numMessages);

        } catch(err) {
            assert.ifError(err);
            assert.fail('Should not throw');
        }
        await closeConnections();
    });
});