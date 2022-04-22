import Redis from 'ioredis';
import assert from 'assert';

import BaseLogger from './base-logger.js'

export default class RedisLogger extends BaseLogger {
    constructor({ logger = console, redisUrl }) {
        super({ logger, enabled: !!redisUrl });

        this.redisUrl = redisUrl;
        this.started = false;

        if (!this.isEnabled) {
            this.logger.warn('Redis logger is disabled');
        }
    }

    /**
     * async init
     * @async
     */
    async init() {
        if (!this.started) {
            if (this.isEnabled) {
                try {
                    this.redis = new Redis(this.redisUrl);
                    this.started = true;
                    return true;
                } catch(err) {
                    this.logger.error('Unable to connect to redis');
                    this.disable();
                    return false;
                }
            } else {
                this.logger.warn('Redis logger is disabled');
                return false;
            }
        }
    }

    /**
     * @async
     * @param {string} id
     * @param {any} message
     * @throws Error 
     */
    async push(id, message) {
        const success = await this.init();
        if (!success) {
            this.logger.warn('Redis logger is disabled');
        } else {

            assert.ok(typeof id === 'string', 'id must be string');
            assert.ok(message, 'message is required');

            const jsonMessage = JSON.stringify(message);
            await this.redis.set(id, jsonMessage);
        }
    }

    /**
     * @async
     * @param {string} id 
     * @returns {any}
     */
    async get(id) {
        const success = await this.init();
        if (!success) {
            this.logger.warn('Redis logger is disabled');
            return;
        } else {
            assert.ok(typeof id === 'string', 'id must be string');
            try{
                const message = await this.redis.get(id);
                return JSON.parse(message);
            } catch(err) {
                this.logger.error(err.message ?? err);
                return;
            }
        }
    }
}