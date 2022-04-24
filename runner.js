// external modules
import { AMQPClient } from '@cloudamqp/amqp-client';
import pino from 'pino';
import {EventEmitter} from 'events';
import assert from 'assert';

// internal modules
import FileLogger from './logger/file-logger.js';
import RedisLogger from './logger/redis-logger.js';

// env vars
const { 
    AMQP_SOURCE_URL, 
    AMQP_SOURCE_CHANNEL, 
    AMQP_SOURCE_QUEUE, 
    AMQP_DESTINATION_URL, 
    AMQP_DESTINATION_QUEUE, 
    REDIS_URL,
    ENABLE_FILE_LOGGER = 'true',
    RETRY_ON_FAIL = 'true', 
    FILE_LOGS_PATH = '/logs/events' ,
    PRINT_RETURNED_BODY = 'false',
    LOG_LEVEL = 'info'
} = process.env;

assert.ok(AMQP_SOURCE_URL, 'AMQP_SOURCE_URL is required');
assert.ok(AMQP_SOURCE_QUEUE, 'AMQP_SOURCE_QUEUE is required');
assert.ok(AMQP_DESTINATION_URL, 'AMQP_DESTINATION_URL is required');

// loggers
const logger = pino({ level: LOG_LEVEL });
const redisLogger = new RedisLogger({ 
    logger, 
    redisUrl: REDIS_URL 
});

const fileLogger = new FileLogger({ 
    logger, 
    enabled: ENABLE_FILE_LOGGER === 'true', 
    logsPath: FILE_LOGS_PATH 
});

// connection map (must be available to shutdown methods)
const connMap = new Map();

export const events = new EventEmitter({ captureRejections: true });

/**
 * consumes from one broker and publishes to another using the same properties
 * @async
 */
export async function run() {
    // queues
    const amqpSource = new AMQPClient(AMQP_SOURCE_URL);
    const amqpDestination = new AMQPClient(AMQP_DESTINATION_URL);

    try {
        // connecting to source queue
        const sourceConn = await amqpSource.connect();
        const sourceChannel = await sourceConn.channel(AMQP_SOURCE_CHANNEL ? parseInt(AMQP_SOURCE_CHANNEL, 10) : undefined);
        const sourceQueue = await sourceChannel.queue(AMQP_SOURCE_QUEUE, { passive: true });
        connMap.set('source', sourceConn);

        // connecting to destination
        const destConn = await amqpDestination.connect();
        // setup a destination channel
        let destChannel = await destConn.channel();
        destChannel.onReturn = handleReturnedMessage;
        connMap.set('dest', destConn);

        // creating an exclusive consumer that requires acknowledge
        const consumer = await sourceQueue.subscribe({exclusive: true, noAck: false}, async (msg) => {

            // format message
            const data = formatMessage(msg);

            try {
                // stores in file, redis, etc
                const id = await storeMessage(msg.properties.messageId, data);
                logger.info('Received message ' + id);

                //publishes to destination
                await publishesMessage(destChannel, id, data);

                // confirms message was received upstream
                await msg.ack(false);
                logger.info('Successfully sent message ' + id);
            } catch(err) {
                // negative acks the message if there is a problem publishing it
                await msg.nack(true, false);
                const errorMessage = `Unable to wirte message with ID ${id} to destination queue`;

                // do not print the body
                const {channel, exchange, routingKey, properties} = data;
                logger.error({channel, exchange, routingKey, properties}, errorMessage);
            } 
        });

    } catch(err) {
        logger.error(err);

        // close connections
        await closeConnections();

        if (RETRY_ON_FAIL === 'true') {
            // retry in 2 seconds
            logger.info(`Retrying in 2 seconds.`);
            setTimeout(run, 2000);
        } else {
            throw err;
        }
    }
}

/**
 * close connections from connMap
 */
export async function closeConnections() {
    for (let [key, conn] of connMap) {
        // connection is not closed and there is a .close method
        if (!conn.closed && conn.close) {
            try {
                await conn.close();
                logger.warn(`Closing ${key} connection.`);
            } catch (err) {
                // just logs
                logger.error(`Unable to close ${key} connection.`);
            }
        }
    }
}

/**
 * graceful shutdown (uses promises instead async/await)
 */
export function startGracefulShutdown() {
    closeConnections()
        .then(() => {
            logger.info('Process has been successfully stopped.');
            process.exit(0);
        })
        .catch((err) => {
            logger.error(err);
            process.abort();
        });
}

/**
 * @async
 * @param {string|undefined} id 
 * @param {any} data 
 * @returns {string} message id or generated id
 */
async function storeMessage(id, data) {
    id = id ?? generateId();

    // tries to cache in redis if it is enabled
    try {
        await redisLogger.push(id, data);
    } catch (redisErr) {
        logger.error(redisErr, 'Failed to log the message to redis');
    }

    // tries to cache in redis if it is enabled
    try {
        await fileLogger.push(id, data);
    } catch (fileErr) {
        logger.error(fileErr, 'Failed to log the message to a file');
    }

    return id;
}

/**
 * @param {AMQPMessage} msg 
 * @returns {Record<string, string|number>}
 */
function formatMessage(msg) {
    return {
        channel: msg.channel?.id,
        exchange: msg.exchange,
        routingKey: msg.routingKey,
        properties: msg.properties,
        body: msg.bodyToString()
    }
}

/**
 * @async
 * @param {AMQPChannel} channel 
 * @param {any} data 
 */
async function publishesMessage(channel, id, data) {
    // tries to publish to the new queue and acks
    // client already caches channels for us
    await channel.confirmSelect();

    if (AMQP_DESTINATION_QUEUE) {
        // tries to deliver to a destination queue directly
        const queue = await channel.queue(AMQP_DESTINATION_QUEUE);
        await queue.publish(data.body, data.properties);
    } else {
        // delivers using an exchange and routingKey (mandatory)
        await channel.basicPublish(data.exchange, data.routingKey, data.body, data.properties, true);
    }

    const host = `${channel.connection.host}:${channel.connection.port}`;
    events.emit('published', host, id, data);
}

async function handleReturnedMessage(msg) {
    // format message
    const data = formatMessage(msg);

    //format id
    const id = msg.properties.messageId ?? generateId();

    // stores in file and/or redis
    await storeMessage(`returned-${id}`, data);
    events.emit('returned', msg);

    const logMessage = `Message ${id} returned`;
    if (PRINT_RETURNED_BODY === 'true') {
        log.warn(data, logMessage);
    } else {
        const {channel, exchange, routingKey, properties} = data;
        logger.warn({channel, exchange, routingKey, properties}, logMessage);
    }            
}

/**
 * id from timestamp. since there is network involved collision is not possible
 * @returns {string}
 */
function generateId() {
    return String(Date.now());
}
