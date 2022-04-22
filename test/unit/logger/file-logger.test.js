import { assert } from 'chai';
import mock from 'mock-fs';

import FileLogger from '../../../logger/file-logger.js';

describe('redis-logger', () => {

    before(() => {
       mock({ '/logs/events/msg-mock.txt': '{"test": true}' });
    });
    
    after(() => {
        mock.restore();
    });

    it('should push and get from redis', async () => {
        const logger = new FileLogger({});
        const value = { ok: true };
        await logger.push('test', value);
        const result = await logger.get('test');
        assert.deepEqual(result, value);
    });

    it('should not store anything if connection fails', async() => {
        const logger = new FileLogger({});
        const result = await logger.get('mock');
        assert.deepEqual(result, {test: true});
    });
});