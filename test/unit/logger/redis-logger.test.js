import { assert } from 'chai';
import sinon from 'sinon';

import RedisLogger from '../../../logger/redis-logger.js';

describe('redis-logger', () => {
    let connectionSuccess;
    let map = new Map();
    
    function getMockRedis() {
        return {
            async set(key, value) {
                map.set(String(key), String(value));
            },
    
            async get(key) {
                return map.get(String(key));
            }
        };
    }

    before(() => {
        sinon.stub(RedisLogger.prototype, 'init').callsFake(async function () {
            this.redis = getMockRedis();
            return connectionSuccess;
        });
    });
    
    beforeEach(() => {
        connectionSuccess = true;
    });

    it('should push and get from redis', async () => {
        const logger = new RedisLogger({ redisUrl: 'fake://test' });
        const value = { ok: true };
        await logger.push('test', value);
        const result = await logger.get('test');
        assert.deepEqual(result, value);
    });

    it('should not store anything if connection fails', async() => {
        connectionSuccess = false;
        const logger = new RedisLogger({ redisUrl: 'fake://test' });
        await logger.push('test', { ok: false });
        const result = await logger.get('test');
        assert.isUndefined(result);
    });
});