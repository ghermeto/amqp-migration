import { writeFile, readFile } from 'fs/promises';
import assert from 'assert';

import BaseLogger from './base-logger.js'

/**
 * logs one message in a different file to account for messages > 1MB
 * @class FileLogger
 */
export default class FileLogger extends BaseLogger {

    constructor({ logger = console, enabled = true, logsPath = '/logs/events'  }) {
        super({ logger, enabled });

        this.logsPath = logsPath;
        if (!this.isEnabled) {
            this.logger.warn('File logger is disabled');
        }
    }

    logFile(id) {
        return `${this.logsPath}/msg-${id}.txt`;
    }

    /**
     * @async
     * @param {string} id 
     * @param {any} message 
     */
    async push(id, message) {
        assert.ok(typeof id === 'string', 'id must be string');
        assert.ok(message, 'message is required');

        if (this.isEnabled) {
            try{
                const jsonMessage = JSON.stringify(message);
                await writeFile(this.logFile(id), jsonMessage);
            } catch(err) {
                this.logger.error(err.message ?? err);
            }
        } else {
            this.logger.warn('File logger is disabled');
        }
    }

    /**
     * @async
     * @param {string} id 
     * @returns {any}
     */
    async get(id) {
        assert.ok(typeof id === 'string', 'id must be string');

        if (this.isEnabled) {
            try{
                const jsonMessage = await readFile(this.logFile(id), { encoding: 'utf8' });
                return JSON.parse(jsonMessage);
            } catch(err) {
                this.logger.error(err.message ?? err);
            }
        } else {
            this.logger.warn('File logger is disabled');
        }
    }
}